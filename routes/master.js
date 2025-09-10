const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const router = express.Router();
const authenticateJWT = require('../middleware/authenticateJWT');
const requireRole = require('../middleware/requireRole');

// Read master data
async function readMasterData() {
  try {
    const dataPath = path.join(__dirname, '../public/data/masterData.json');
    
    // Check if file exists
    try {
      await fs.access(dataPath);
    } catch (err) {
      console.error('Master data file does not exist:', dataPath);
      return {};
    }
    
    const data = await fs.readFile(dataPath, 'utf8');
    
    // Handle empty file
    if (!data.trim()) {
      console.warn('Master data file is empty');
      return {};
    }
    
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading master data:', err);
    return {};
  }
}

// Write master data
async function writeMasterData(data) {
  try {
    const dataPath = path.join(__dirname, '../public/data/masterData.json');
    
    // Ensure directory exists
    const dirPath = path.dirname(dataPath);
    await fs.mkdir(dirPath, { recursive: true });
    
    await fs.writeFile(dataPath, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    console.error('Error writing master data:', err);
    return false;
  }
}

// Master dashboard route
router.get('/dashboard/master', authenticateJWT, requireRole(['admin']), async (req, res) => {
  try {
    const masterData = await readMasterData();
    
    // Log available locations for debugging
    console.log('Available locations in masterData:', Object.keys(masterData));
    console.log('User location:', req.user.location);
    
    // Case-insensitive location matching
    const locationKeys = Object.keys(masterData);
    const userLocation = req.user.location.toLowerCase();
    const locationKey = locationKeys.find(key => key.toLowerCase() === userLocation);
    
    const locationData = locationKey ? masterData[locationKey] : {};
    
    // Log location data for debugging
    console.log('Location data for', req.user.location, ':', locationData);
    
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

// API endpoint to get master data
router.get('/dashboard/master/data', authenticateJWT, requireRole(['admin']), async (req, res) => {
  try {
    const masterData = await readMasterData();
    
    // Case-insensitive location matching
    const locationKeys = Object.keys(masterData);
    const userLocation = req.user.location.toLowerCase();
    const locationKey = locationKeys.find(key => key.toLowerCase() === userLocation);
    
    const locationData = locationKey ? masterData[locationKey] : {};
    
    res.json({ 
      success: true, 
      masterData: locationData 
    });
  } catch (err) {
    console.error('Error fetching master data:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch master data' 
    });
  }
});

// Update master data endpoint
router.post('/dashboard/master/update', authenticateJWT, requireRole(['admin']), async (req, res) => {
  try {
    const { location: requestedLocation, masterData: newLocationData } = req.body;
    
    // Validate that user can only update their own location
    if (requestedLocation.toLowerCase() !== req.user.location.toLowerCase()) {
      return res.status(403).json({ 
        success: false, 
        message: 'Cannot update data for other locations' 
      });
    }
    
    // Read current master data
    const allData = await readMasterData();
    
    // Case-insensitive location matching for update
    const locationKeys = Object.keys(allData);
    const userLocation = req.user.location.toLowerCase();
    const locationKey = locationKeys.find(key => key.toLowerCase() === userLocation) || req.user.location;
    
    // Update data for this location
    allData[locationKey] = newLocationData;
    
    // Write updated data back to file
    const success = await writeMasterData(allData);
    
    if (success) {
      res.json({ 
        success: true, 
        message: 'Data updated successfully' 
      });
    } else {
      res.status(500).json({ 
        success: false, 
        message: 'Failed to update data' 
      });
    }
  } catch (err) {
    console.error('Update master data error:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to update data' 
    });
  }
});

module.exports = router;