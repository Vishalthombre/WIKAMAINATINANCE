const express = require('express');
const router  = express.Router();
const db      = require('../db');
const nodemailer = require('nodemailer');
const bcrypt  = require('bcrypt');

// configure smtp
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: (process.env.SMTP_SECURE === 'true'),
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

// ------------------------ GET /forgot-password ------------------------
router.get('/forgot-password', (req,res)=>{
  res.render('forgot-password',{ step:'globalId', error:null, message:null });
});

// -------------------- POST /forgot-password (Send OTP) ----------------
router.post('/forgot-password', async (req,res)=>{
  try {
    const { globalId } = req.body;
    if(!globalId){
      return res.render('forgot-password',{ step:'globalId', error:'Please enter Global ID', message:null });
    }

    // fetch user
    const rows = await db.query("SELECT global_id,name,email FROM users WHERE global_id = ?", [globalId]);
    if(!rows.length){
      return res.render('forgot-password',{ step:'globalId', error:'User not found', message:null });
    }

    // unwrap MSSQL wrapper and normalize
    let raw = rows[0];
    if(raw && raw["0"]) raw = raw["0"];
    const user = Object.fromEntries(Object.entries(raw).map(([k,v])=>[k.toLowerCase(), v]));

    if(!user.email || user.email.trim() === ''){
      return res.render('forgot-password',{ step:'globalId', error:'No e-mail registered for this user', message:null });
    }

    // create, store OTP in session
    const otp = Math.floor(100000 + Math.random()*900000).toString();
    req.session.resetOtp     = otp;
    req.session.resetUserId  = globalId;
    req.session.otpExpiry    = Date.now() + 15*60*1000;  // 15 minutes

    // send OTP via email
    await transporter.sendMail({
      from:`WIKA Maint <${process.env.SMTP_USER}>`,
      to: user.email,
      subject:'OTP for password reset',
      html:`<p>Hello ${user.name},</p><p>Your OTP is <strong>${otp}</strong> (valid for 15 minutes).</p>`
    });

    res.render('forgot-password',{ step:'otp', globalId, error:null, message:'OTP sent to your email.' });

  } catch(err){
    console.error("Forgot-password error:",err);
    return res.render('forgot-password',{ step:'globalId', error:"Server error. Try again.", message:null });
  }
});

// ---------------------- POST /forgot-password/verify-otp --------------
router.post('/forgot-password/verify-otp', (req,res)=>{
  const { globalId, otp } = req.body;

  if(!otp){
    return res.render('forgot-password',{ step:'otp', globalId, error:'Please enter OTP', message:null });
  }

  const validOtp  = req.session.resetOtp === otp;
  const validUser = req.session.resetUserId === globalId;
  const notExpired = req.session.otpExpiry && (Date.now() < req.session.otpExpiry);

  if(!validOtp || !validUser || !notExpired){
    return res.render('forgot-password',{ step:'otp', globalId, error:'Invalid or expired OTP', message:null });
  }

  res.render('forgot-password',{ step:'setPassword', globalId, error:null, message:null });
});

// ---------------------- POST /forgot-password/set-password -----------
router.post('/forgot-password/set-password', async (req,res)=>{
  const { globalId, password, confirmPassword } = req.body;

  if(!password || !confirmPassword){
    return res.render('forgot-password',{ step:'setPassword', globalId, error:'Both password fields required', message:null });
  }
  if(password !== confirmPassword){
    return res.render('forgot-password',{ step:'setPassword', globalId, error:'Passwords do not match', message:null });
  }

  try {
    // hash new password
    const hashed = await bcrypt.hash(password, 10);

    await db.query(
      `UPDATE users
         SET password = ?
       WHERE global_id = ?`,
      [hashed, globalId]
    );

    // clear session OTP
    req.session.resetOtp = null;
    req.session.resetUserId = null;
    req.session.otpExpiry = null;

    return res.redirect('/login');
  } catch(err){
    console.error(err);
    return res.render('forgot-password',{ step:'setPassword', globalId, error:'Could not update password', message:null });
  }
});

module.exports = router;
