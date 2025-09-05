// db.js
// MSSQL wrapper that mimics mysql2 db.query(sql, params) usage with "?" placeholders.
// It transforms SQL with ? into parameterized mssql SQL with @p1, @p2... and binds inputs.
//
// Requirements: npm install mssql
const sql = require('mssql');
require("dotenv").config();

// Updated configuration for Somee.com
const config = {
  user: process.env.DB_USER || 'vishalthombre_SQLLogin_1', // Your Somee.com username
  password: process.env.DB_PASSWORD || 'tic9idueos', // Your Somee.com password
  server: process.env.DB_SERVER || process.env.DB_HOST || 'WIKAMaint.mssql.somee.com', // Somee.com server address
  database: process.env.DB_NAME || 'WIKAMaint', // Your database name
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 1433, // Default MSSQL port
  options: {
    encrypt: true, // ✅ REQUIRED for Somee.com
    trustServerCertificate: true // ✅ REQUIRED to avoid certificate errors
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000
  }
};

// Create a single pool as soon as the module is loaded
const poolPromise = sql.connect(config)
  .then(pool => {
    console.log(`✅ MSSQL pool created: ${config.server}:${config.port} / DB ${config.database}`);
    return pool;
  })
  .catch(err => {
    console.error('❌ MSSQL connection failed:', err);
    // rethrow so any awaiters fail as well
    throw err;
  });

/**
 * Convert SQL with positional "?" placeholders into named mssql params:
 * "SELECT * FROM tickets WHERE global_id = ? AND location = ?" => "SELECT * FROM tickets WHERE global_id = @p1 AND location = @p2"
 * Returns mappedSql and inputs object { p1: value1, p2: value2 }
 */
function mapSqlAndInputs(sqlText = '', params = []) {
  let index = 0;
  const inputs = {};
  const mapped = String(sqlText).replace(/\?/g, () => {
    index++;
    const name = `p${index}`;
    inputs[name] = params[index - 1];
    return `@${name}`;
  });
  return { mappedSql: mapped, inputs };
}

/**
 * query(sqlWithQuestionMarks, paramsArray)
 * Returns a Promise that resolves to [rows, result] so code that expects mysql2 style
 * (e.g. const [rows] = await db.query(...)) keeps working.
 */
async function query(sqlText, params = []) {
  const pool = await poolPromise;
  const { mappedSql, inputs } = mapSqlAndInputs(sqlText, params);

  const request = pool.request();

  // Bind inputs with simple type inference
  for (const [key, val] of Object.entries(inputs)) {
    try {
      if (val === null || val === undefined) {
        request.input(key, sql.NVarChar, null);
      } else if (typeof val === 'number' && Number.isInteger(val)) {
        request.input(key, sql.Int, val);
      } else if (typeof val === 'number') {
        request.input(key, sql.Float, val);
      } else if (typeof val === 'boolean') {
        request.input(key, sql.Bit, val ? 1 : 0);
      } else if (val instanceof Date) {
        request.input(key, sql.DateTime, val);
      } else {
        request.input(key, sql.NVarChar(sql.MAX), String(val));
      }
    } catch (err) {
      // fallback: bind as NVARCHAR
      request.input(key, sql.NVarChar(sql.MAX), val == null ? null : String(val));
    }
  }

  const result = await request.query(mappedSql);
  // Return [rows, result] to keep compatibility with mysql2-style usage
  return [result.recordset, result];
}

/**
 * connectTest(): waits for pool to be ready and executes a small query.
 * Used in app startup to ensure DB connectivity before listening.
 */
async function connectTest() {
  try {
    const pool = await poolPromise;
    // simple ping
    const r = await pool.request().query('SELECT 1 AS ok');
    console.log(`✅ MSSQL Connected:, ${config.server}:${config.port} / DB ${config.database}`);
    return r;
  } catch (err) {
    console.error('❌ MSSQL connectTest failed:', err);
    throw err;
  }
}

/**
 * Keep-alive: ping database every 30 seconds so the MSSQL pool remains active.
 * This prevents Node from exiting due to no active handles (mssql pool can go idle).
 */
setInterval(async () => {
  try {
    // Use the query wrapper to keep behavior consistent
    await query('SELECT 1');
    // optional: console.debug('MSSQL keep-alive success');
  } catch (err) {
    console.error('MSSQL keep-alive error:', err);
  }
}, 30000);

// Export API
module.exports = {
  query,
  sql,
  poolPromise,
  connectTest
};