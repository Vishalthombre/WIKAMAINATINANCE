// routes/planner.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const requireRole = require('../middleware/requireRole');
const webPush = require('web-push');
const authenticateJWT = require('../middleware/authenticateJWT');

// ✅ Import shared subscription store
const subscriptionsPerUser = require('../subscriptions');

// -------- Web Push Setup --------
webPush.setVapidDetails(
  'mailto:info@yourcompany.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ✅ Helper: send notification to a specific user
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
      console.warn('⚠️ Failed to send notification to', targetGlobalId, err);
    }
  }
}

// ===============================
// GET: Planner Dashboard
// ===============================
router.get(
  '/dashboard/planner',
  authenticateJWT,
  requireRole(['planner', 'admin']),
  async (req, res) => {
    const user = req.user;
    const userRole = user?.role;
    const userLocation = user?.location;

    try {
      let query = `
        SELECT 
          t.*, 
          u.name AS assigned_to_name
        FROM tickets t
        LEFT JOIN users u ON t.assigned_to = u.global_id
        WHERE 1=1
      `;
      const params = [];

      // Only Pune admin can see all tickets
      if (!(userRole === 'admin' && userLocation === 'Pune')) {
        query += ` AND t.location = ?`;
        params.push(userLocation);
      }

      query += ` ORDER BY t.created_at DESC`;

      const result = await db.query(query, params);
      const tickets = result.recordset || result;

      // Fetch technicians list (filtered by location for non-Pune admin)
      let techQuery = `
        SELECT global_id, name, location
        FROM users 
        WHERE department IN ('technician', 'planner', 'admin')
      `;
      const techParams = [];

      if (!(userRole === 'admin' && userLocation === 'Pune')) {
        techQuery += ` AND location = ?`;
        techParams.push(userLocation);
      }

      techQuery += ` ORDER BY name`;

      const techResult = await db.query(techQuery, techParams);
      const technicians = techResult.recordset || techResult;

      res.render('dashboard-planner', {
        tickets,
        technicians,
        user,
      });
    } catch (err) {
      console.error('Planner dashboard error:', err);
      res.status(500).send('Error loading planner dashboard');
    }
  }
);

// ===============================
// POST: Assign Ticket
// ===============================
router.post(
  '/planner/assign',
  authenticateJWT,
  requireRole(['planner', 'admin']),
  async (req, res) => {
    const { ticketId, executerId } = req.body;
    const user = req.user;
    const assignerGlobalId = user?.globalId;
    const userRole = user?.role;
    const userLocation = user?.location;

    if (!ticketId || !executerId) {
      return res.status(400).send('Missing ticketId or executerId');
    }

    try {
      let query = `
        UPDATE tickets 
        SET assigned_to = ?, planner_id = ?, status = 'Assigned', updated_at = GETDATE()
        WHERE id = ?
      `;
      const params = [executerId, assignerGlobalId, ticketId];

      if (!(userRole === 'admin' && userLocation === 'Pune')) {
        query += ` AND location = ?`;
        params.push(userLocation);
      }

      const result = await db.query(query, params);

      if (result.rowsAffected && result.rowsAffected[0] === 0) {
        return res.status(404).send('❌ Ticket not found or no permission.');
      }

      // ✅ Send notification to the assigned technician only
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

// ===============================
// POST: Subscribe to Notifications
// ===============================
router.post(
  '/notifications/subscribe',
  authenticateJWT,
  (req, res) => {
    const user = req.user;
    if (!user?.globalId) {
      return res.status(401).send('Unauthorized: Please log in.');
    }

    const userId = user.globalId;
    const subscription = req.body;

    if (!subscriptionsPerUser[userId]) subscriptionsPerUser[userId] = [];

    // Avoid duplicates
    const exists = subscriptionsPerUser[userId].some(
      (sub) => sub.endpoint === subscription.endpoint
    );
    if (!exists) {
      subscriptionsPerUser[userId].push(subscription);
      console.log(
        `✅ Subscription saved for user ${userId}:`,
        subscription.endpoint
      );
    }

    res.sendStatus(201);
  }
);

module.exports = router;