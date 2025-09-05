// routes/ticket.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const requireRole = require('../middleware/requireRole');
const webPush = require('web-push');
const subscriptionsPerUser = require('../subscriptions');

// ✅ Correct import
const authenticateJWT = require('../middleware/authenticateJWT');

// -------- Web Push Setup --------
webPush.setVapidDetails(
  'mailto:info@yourcompany.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// Helper: send notification to a specific user
async function sendNotificationToUser(message, targetGlobalId) {
  const userSubs = subscriptionsPerUser[targetGlobalId] || [];
  for (const sub of userSubs) {
    try {
      await webPush.sendNotification(
        sub,
        JSON.stringify({
          title: 'Ticket Update',
          body: message,
        })
      );
    } catch (err) {
      console.warn(`⚠️ Failed to send notification to ${targetGlobalId}:`, err);
    }
  }
}

// ==============================
// POST: Submit Ticket
// ==============================
router.post(
  '/ticket/submit',
  authenticateJWT,
  requireRole(['normal_user', 'technician', 'planner', 'admin']),
  async (req, res) => {
    try {
      const user = req.user;
      if (!user?.globalId) {
        return res.status(401).send('Unauthorized: Please log in again.');
      }

      let { category, description, building_no, area_code, sub_area, keyword } =
        req.body;

      // Normalize category
      if (category === 'Facility' || category === 'Facility Service')
        category = 'Facility Service';
      else if (!category) category = 'Other';

      // Facility Service requires specific fields
      if (category === 'Facility Service') {
        if (!building_no || !area_code || !sub_area || !keyword) {
          const msg = encodeURIComponent(
            'Missing required Facility Service fields.'
          );
          return res.redirect(`/dashboard/user?error=${msg}`);
        }
      }

      // Insert ticket
      await db.query(
        `
        INSERT INTO tickets
          (global_id, raised_by, category, description, building_no, area_code, sub_area, keyword, location, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Open', GETDATE(), GETDATE())
        `,
        [
          user.globalId,
          user.name || null,
          category,
          description || null,
          building_no || null,
          area_code || null,
          sub_area || null,
          keyword || null,
          user.location || null,
        ]
      );

      // Notify user
      sendNotificationToUser(
        '✅ Your ticket has been submitted successfully.',
        user.globalId
      );

      const successMsg = encodeURIComponent('Ticket submitted successfully.');
      return res.redirect(`/dashboard/user?message=${successMsg}`);
    } catch (err) {
      console.error('Error submitting ticket:', err);
      const errMsg = encodeURIComponent('Failed to submit ticket.');
      return res.redirect(`/dashboard/user?error=${errMsg}`);
    }
  }
);

// ==============================
// POST: Assign Ticket
// ==============================
router.post(
  '/ticket/assign',
  authenticateJWT,
  requireRole(['planner', 'admin']),
  async (req, res) => {
    const { ticketId, executerId } = req.body;
    const assignerGlobalId = req.user?.globalId;

    if (!ticketId || !executerId) {
      return res.status(400).send('Missing ticketId or executerId');
    }

    try {
      const result = await db.query(
        `
        UPDATE tickets 
        SET assigned_to = ?, planner_id = ?, status = 'Assigned', updated_at = GETDATE()
        WHERE id = ?
        `,
        [executerId, assignerGlobalId, ticketId]
      );

      if (result.rowsAffected && result.rowsAffected[0] === 0) {
        return res.status(404).send('❌ Ticket not found.');
      }

      // Notify technician
      sendNotificationToUser(
        `📌 Ticket ID ${ticketId} has been assigned to you.`,
        executerId
      );

      res.redirect('/dashboard/planner');
    } catch (err) {
      console.error('Assignment error:', err);
      res.status(500).send('❌ Failed to assign technician.');
    }
  }
);

// ==============================
// POST: Complete Ticket
// ==============================
router.post(
  '/ticket/complete',
  authenticateJWT,
  requireRole(['technician', 'planner', 'admin']),
  async (req, res) => {
    const { ticketId } = req.body;

    if (!ticketId) return res.status(400).send('Missing ticketId');

    try {
      const result = await db.query(
        `SELECT global_id FROM tickets WHERE id = ?`,
        [ticketId]
      );

      const ticketRows = result.recordset || result;
      if (!ticketRows || ticketRows.length === 0) {
        return res.status(404).send('Ticket not found');
      }

      const ticketOwner = ticketRows[0].global_id;

      await db.query(
        `UPDATE tickets SET status = 'Completed', updated_at = GETDATE() WHERE id = ?`,
        [ticketId]
      );

      // Notify the user who raised it
      sendNotificationToUser(
        `🎉 Your ticket ID ${ticketId} has been marked as completed.`,
        ticketOwner
      );

      res.redirect('/dashboard/planner');
    } catch (err) {
      console.error('Completion error:', err);
      res.status(500).send('❌ Failed to complete ticket.');
    }
  }
);

// ==============================
// Web Push Routes
// ==============================
router.get('/notifications/public-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY });
});

router.post('/notifications/subscribe', authenticateJWT, (req, res) => {
  try {
    const user = req.user;
    if (!user?.globalId) {
      return res.status(401).json({ error: 'Unauthorized: Please log in.' });
    }

    const userId = user.globalId;
    const subscription = req.body;

    if (!subscriptionsPerUser[userId]) {
      subscriptionsPerUser[userId] = [];
    }

    const exists = subscriptionsPerUser[userId].some(
      (sub) => sub.endpoint === subscription.endpoint
    );

    if (!exists) {
      subscriptionsPerUser[userId].push(subscription);
      console.log(
        `✅ Subscription saved for user ${userId}:`,
        subscription.endpoint
      );
    } else {
      console.log(`ℹ️ Subscription already exists for user ${userId}`);
    }

    res.status(201).json({ success: true });
  } catch (err) {
    console.error('❌ Error saving subscription:', err);
    res.status(500).json({ error: 'Failed to save subscription' });
  }
});

module.exports = router;