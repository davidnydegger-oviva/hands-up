require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'oviva2026';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// --- SSE Client Management ---
const sseClients = new Map(); // meetingId -> Set of response objects

function addSSEClient(meetingId, res) {
  if (!sseClients.has(meetingId)) sseClients.set(meetingId, new Set());
  sseClients.get(meetingId).add(res);
  res.on('close', () => {
    const clients = sseClients.get(meetingId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) sseClients.delete(meetingId);
    }
  });
}

function broadcastState(meetingId) {
  const clients = sseClients.get(meetingId);
  if (!clients || clients.size === 0) return;
  const state = getMeetingState(meetingId);
  const data = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of clients) {
    res.write(data);
  }
}

// Also broadcast to "active" listeners
const activeSSEClients = new Set();

function broadcastActiveState() {
  const active = db.prepare('SELECT id FROM meetings WHERE is_active = 1').get();
  if (!active) {
    const data = `data: ${JSON.stringify({ active: false })}\n\n`;
    for (const res of activeSSEClients) res.write(data);
    return;
  }
  const state = getMeetingState(active.id);
  state.meetingId = active.id;
  state.active = true;
  const data = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of activeSSEClients) res.write(data);
}

// --- Helpers ---
function getMeetingState(meetingId) {
  const assignments = db.prepare(
    'SELECT button_number, person_name FROM button_assignments WHERE meeting_id = ?'
  ).all(meetingId);

  const raised = db.prepare(
    'SELECT h.button_number, h.raised_at FROM hand_raises h WHERE h.meeting_id = ? AND h.is_raised = 1 ORDER BY h.raised_at ASC'
  ).all(meetingId);

  const raisedButtons = new Set(raised.map(r => r.button_number));

  const meeting = db.prepare('SELECT name FROM meetings WHERE id = ?').get(meetingId);

  const queue = raised.map(r => {
    const assignment = assignments.find(a => a.button_number === r.button_number);
    return {
      button_number: r.button_number,
      person_name: assignment ? assignment.person_name : `Button ${r.button_number}`,
      raised_at: r.raised_at
    };
  });

  const inactive = assignments
    .filter(a => !raisedButtons.has(a.button_number))
    .map(a => ({ button_number: a.button_number, person_name: a.person_name }))
    .sort((a, b) => a.button_number - b.button_number);

  return { meetingName: meeting ? meeting.name : '', queue, inactive };
}

function getActiveMeeting() {
  return db.prepare('SELECT * FROM meetings WHERE is_active = 1').get();
}

// --- Auth Middleware ---
function requireAdmin(req, res, next) {
  const auth = req.headers['x-admin-password'];
  if (auth !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// --- Button Endpoints (Flic hub) ---
app.post('/api/button/:buttonNumber/raise', (req, res) => {
  try {
    const buttonNumber = parseInt(req.params.buttonNumber, 10);
    const meeting = getActiveMeeting();
    if (!meeting) return res.json({ ok: true });

    const assignment = db.prepare(
      'SELECT * FROM button_assignments WHERE meeting_id = ? AND button_number = ?'
    ).get(meeting.id, buttonNumber);
    if (!assignment) return res.json({ ok: true });

    const existing = db.prepare(
      'SELECT * FROM hand_raises WHERE meeting_id = ? AND button_number = ? AND is_raised = 1'
    ).get(meeting.id, buttonNumber);
    if (existing) return res.json({ ok: true });

    db.prepare(
      'INSERT INTO hand_raises (id, meeting_id, button_number, raised_at, is_raised) VALUES (?, ?, ?, datetime(\'now\'), 1)'
    ).run(uuidv4(), meeting.id, buttonNumber);

    broadcastState(meeting.id);
    broadcastActiveState();
    res.json({ ok: true });
  } catch (err) {
    console.error('Error raising hand:', err);
    res.json({ ok: true });
  }
});

app.post('/api/button/:buttonNumber/lower', (req, res) => {
  try {
    const buttonNumber = parseInt(req.params.buttonNumber, 10);
    const meeting = getActiveMeeting();
    if (!meeting) return res.json({ ok: true });

    db.prepare(
      'UPDATE hand_raises SET is_raised = 0 WHERE meeting_id = ? AND button_number = ? AND is_raised = 1'
    ).run(meeting.id, buttonNumber);

    broadcastState(meeting.id);
    broadcastActiveState();
    res.json({ ok: true });
  } catch (err) {
    console.error('Error lowering hand:', err);
    res.json({ ok: true });
  }
});

// --- Facilitator Endpoints ---
app.post('/api/meetings/:meetingId/next', (req, res) => {
  const { meetingId } = req.params;
  const top = db.prepare(
    'SELECT * FROM hand_raises WHERE meeting_id = ? AND is_raised = 1 ORDER BY raised_at ASC LIMIT 1'
  ).get(meetingId);

  if (top) {
    db.prepare('UPDATE hand_raises SET is_raised = 0 WHERE id = ?').run(top.id);
    broadcastState(meetingId);
    broadcastActiveState();
  }

  res.json({ ok: true });
});

app.post('/api/meetings/:meetingId/clear', (req, res) => {
  const { meetingId } = req.params;
  db.prepare('UPDATE hand_raises SET is_raised = 0 WHERE meeting_id = ? AND is_raised = 1').run(meetingId);
  broadcastState(meetingId);
  broadcastActiveState();
  res.json({ ok: true });
});

// --- Admin CRUD ---
app.get('/api/meetings', requireAdmin, (req, res) => {
  const meetings = db.prepare('SELECT * FROM meetings ORDER BY created_at DESC').all();
  res.json(meetings);
});

app.post('/api/meetings', requireAdmin, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const id = uuidv4();
  db.prepare('INSERT INTO meetings (id, name, created_at, is_active) VALUES (?, ?, datetime(\'now\'), 0)').run(id, name);
  const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(id);
  res.json(meeting);
});

app.put('/api/meetings/:id', requireAdmin, (req, res) => {
  const { name } = req.body;
  db.prepare('UPDATE meetings SET name = ? WHERE id = ?').run(name, req.params.id);
  const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id);
  res.json(meeting);
});

app.delete('/api/meetings/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM meetings WHERE id = ?').run(req.params.id);
  broadcastActiveState();
  res.json({ ok: true });
});

app.post('/api/meetings/:id/activate', requireAdmin, (req, res) => {
  db.prepare('UPDATE meetings SET is_active = 0 WHERE is_active = 1').run();
  db.prepare('UPDATE meetings SET is_active = 1 WHERE id = ?').run(req.params.id);
  broadcastActiveState();
  res.json({ ok: true });
});

app.post('/api/meetings/:id/deactivate', requireAdmin, (req, res) => {
  db.prepare('UPDATE meetings SET is_active = 0 WHERE id = ?').run(req.params.id);
  broadcastActiveState();
  res.json({ ok: true });
});

// --- Assignments ---
app.get('/api/meetings/:id/assignments', requireAdmin, (req, res) => {
  const assignments = db.prepare(
    'SELECT * FROM button_assignments WHERE meeting_id = ? ORDER BY button_number'
  ).all(req.params.id);
  res.json(assignments);
});

app.put('/api/meetings/:id/assignments', requireAdmin, (req, res) => {
  const meetingId = req.params.id;
  const assignments = req.body;

  const deleteAll = db.prepare('DELETE FROM button_assignments WHERE meeting_id = ?');
  const insert = db.prepare(
    'INSERT INTO button_assignments (id, meeting_id, button_number, person_name) VALUES (?, ?, ?, ?)'
  );

  const tx = db.transaction(() => {
    deleteAll.run(meetingId);
    for (const a of assignments) {
      if (a.person_name && a.person_name.trim()) {
        insert.run(uuidv4(), meetingId, a.button_number, a.person_name.trim());
      }
    }
  });
  tx();

  broadcastState(meetingId);
  broadcastActiveState();
  const updated = db.prepare('SELECT * FROM button_assignments WHERE meeting_id = ? ORDER BY button_number').all(meetingId);
  res.json(updated);
});

// --- State Endpoint ---
app.get('/api/meetings/:meetingId/state', (req, res) => {
  res.json(getMeetingState(req.params.meetingId));
});

// --- SSE Endpoints ---
app.get('/api/meetings/:meetingId/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write('retry: 3000\n\n');

  const state = getMeetingState(req.params.meetingId);
  res.write(`data: ${JSON.stringify(state)}\n\n`);

  addSSEClient(req.params.meetingId, res);
});

app.get('/api/active/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write('retry: 3000\n\n');

  const active = db.prepare('SELECT id FROM meetings WHERE is_active = 1').get();
  if (active) {
    const state = getMeetingState(active.id);
    state.meetingId = active.id;
    state.active = true;
    res.write(`data: ${JSON.stringify(state)}\n\n`);
  } else {
    res.write(`data: ${JSON.stringify({ active: false })}\n\n`);
  }

  activeSSEClients.add(res);
  res.on('close', () => activeSSEClients.delete(res));
});

// --- Active meeting state (no auth) ---
app.get('/api/active/state', (req, res) => {
  const active = db.prepare('SELECT id FROM meetings WHERE is_active = 1').get();
  if (!active) return res.json({ active: false });
  const state = getMeetingState(active.id);
  state.meetingId = active.id;
  state.active = true;
  res.json(state);
});

// --- Start Server ---
app.listen(PORT, () => {
  console.log(`Hands Up running on http://localhost:${PORT}`);
});
