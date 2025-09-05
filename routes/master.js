const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const router = express.Router();
const authenticateJWT = require('../middleware/authenticateJWT'); // Add this import
const requireRole = require('../middleware/requireRole'); // Add this import

// Remove the custom requireAdmin function and use requireRole instead

// Read master data
async function readMasterData() {
  try {
    const dataPath = path.join(__dirname, '../public/data/masterData.json');
    const data = await fs.readFile(dataPath, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading master data:', err);
    return {};
  }
}

// Write master data
async function writeMasterData(data) {
  try {
    const dataPath = path.join(__dirname, '../public/masterData.json');
    await fs.writeFile(dataPath, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    console.error('Error writing master data:', err);
    return false;
  }
}

// Master dashboard route - Use authenticateJWT and requireRole
router.get('/dashboard/master', authenticateJWT, requireRole(['admin']), async (req, res) => {
  try {
    const masterData = await readMasterData();
    const locationData = masterData[req.user.location] || {};
    
    res.render('dashboard-master', {
      masterData: locationData,
      user: req.user,
      message: req.query.message || null,
      error: req.query.error || null
    });
  } catch (err) {
    console.error('Master dashboard error:', err);
    res.status(500).send('Failed to load master data dashboard');
  }
});

// Update master data route - Use authenticateJWT and requireRole
router.post('/dashboard/master/update', authenticateJWT, requireRole(['admin']), async (req, res) => {
  try {
    const { category, subcategory, nestedKey, item, action, newValue, oldValue } = req.body;
    const masterData = await readMasterData();
    
    if (!masterData[req.user.location]) {
      masterData[req.user.location] = {};
    }
    
    const locationData = masterData[req.user.location];
    
    // Handle different actions (add, edit, delete)
    if (action === 'add') {
      if (!locationData[category]) {
        locationData[category] = {};
      }
      
      if (nestedKey) {
        // Handle nested structure (Facility, Safety)
        if (!locationData[category][subcategory]) {
          locationData[category][subcategory] = {};
        }
        
        if (!locationData[category][subcategory][nestedKey]) {
          locationData[category][subcategory][nestedKey] = [];
        }
        
        if (newValue && !locationData[category][subcategory][nestedKey].includes(newValue)) {
          locationData[category][subcategory][nestedKey].push(newValue);
        }
      } else {
        // Handle flat structure (Breakdown)
        if (!locationData[category][subcategory]) {
          locationData[category][subcategory] = [];
        }
        
        if (newValue && !locationData[category][subcategory].includes(newValue)) {
          locationData[category][subcategory].push(newValue);
        }
      }
    } else if (action === 'edit') {
      if (nestedKey) {
        // Handle nested structure
        if (locationData[category] && locationData[category][subcategory] && locationData[category][subcategory][nestedKey]) {
          const index = locationData[category][subcategory][nestedKey].indexOf(oldValue);
          if (index !== -1) {
            locationData[category][subcategory][nestedKey][index] = newValue;
          }
        }
      } else {
        // Handle flat structure
        if (locationData[category] && locationData[category][subcategory]) {
          const index = locationData[category][subcategory].indexOf(oldValue);
          if (index !== -1) {
            locationData[category][subcategory][index] = newValue;
          }
        }
      }
    } else if (action === 'delete') {
      if (nestedKey) {
        // Handle nested structure
        if (locationData[category] && locationData[category][subcategory] && locationData[category][subcategory][nestedKey]) {
          const index = locationData[category][subcategory][nestedKey].indexOf(item);
          if (index !== -1) {
            locationData[category][subcategory][nestedKey].splice(index, 1);
          }
        }
      } else {
        // Handle flat structure
        if (locationData[category] && locationData[category][subcategory]) {
          const index = locationData[category][subcategory].indexOf(item);
          if (index !== -1) {
            locationData[category][subcategory].splice(index, 1);
          }
        }
      }
    }
    
    // Save the updated data
    const success = await writeMasterData(masterData);
    
    if (success) {
      res.redirect('/dashboard/master?message=Data updated successfully');
    } else {
      res.redirect('/dashboard/master?error=Failed to update data');
    }
  } catch (err) {
    console.error('Update master data error:', err);
    res.redirect('/dashboard/master?error=Failed to update data');
  }
});

module.exports = router;