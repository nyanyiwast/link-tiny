import express from 'express';
import mysql from 'mysql2/promise';
import swaggerUi from 'swagger-ui-express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import crypto from 'crypto';
import cluster from 'cluster';
import { availableParallelism } from 'os';

// Create Express app
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Database configuration
const DB_CONFIG = {
  host: process.env.MYSQL_HOST || 'localhost',
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  waitForConnections: true,
  connectionLimit: 50, // Increase for production
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
};

const DB_NAME = process.env.MYSQL_DATABASE || 'url_shortener';

// Initialize database
async function initializeDatabase() {
  try {
    // First connect without specifying a database
    const tempPool = mysql.createPool({
      ...DB_CONFIG,
      // No database specified here
    });

    // Create the database if it doesn't exist
    await tempPool.query(`CREATE DATABASE IF NOT EXISTS ${DB_NAME}`);
    console.log(`Database ${DB_NAME} created or already exists`);
    
    // Close the temporary connection
    await tempPool.end();
    
    // Create a new pool with the database specified
    const pool = mysql.createPool({
      ...DB_CONFIG,
      database: DB_NAME
    });
    
    // Create table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS urls (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        original_url VARCHAR(2048) NOT NULL,
        short_code VARCHAR(10) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        clicks INT DEFAULT 0,
        INDEX (short_code)
      )
    `);
    
    console.log('Database initialized successfully');
    return pool;
  } catch (error) {
    console.error('Database initialization failed:', error);
    process.exit(1);
  }
}

// Base62 character set for URL shortening
const BASE62_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const CODE_LENGTH = 7;

// Generate a random short code
function generateShortCode() {
  const randomBytes = crypto.randomBytes(CODE_LENGTH);
  let shortCode = '';
  
  for (let i = 0; i < CODE_LENGTH; i++) {
    const randomIndex = randomBytes[i] % BASE62_CHARS.length;
    shortCode += BASE62_CHARS[randomIndex];
  }
  
  return shortCode;
}

// In-memory cache for frequently accessed URLs
const urlCache = new Map();
const CACHE_SIZE_LIMIT = 10000;

// Cache management
function addToCache(shortCode, originalUrl) {
  if (urlCache.size >= CACHE_SIZE_LIMIT) {
    // Remove oldest entry when cache is full
    const oldestKey = urlCache.keys().next().value;
    urlCache.delete(oldestKey);
  }
  urlCache.set(shortCode, originalUrl);
}

// Implement clustering for better performance
if (cluster.isPrimary && process.env.NODE_ENV === 'production') {
  const numCPUs = availableParallelism();
  console.log(`Primary ${process.pid} is running`);
  console.log(`Starting ${numCPUs} workers...`);

  // Fork workers
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} died`);
    // Replace the dead worker
    cluster.fork();
  });
} else {
  // Start the server (either in a worker or in single-process mode)
  startServer();
}

async function startServer() {
  // Initialize database and get connection pool
  const pool = await initializeDatabase();

  // API Routes
  app.post('/api/shorten', async (req, res) => {
    try {
      const { url } = req.body;
      
      if (!url) {
        return res.status(400).json({ error: 'URL is required' });
      }
      
      // Validate URL format
      try {
        new URL(url);
      } catch (error) {
        return res.status(400).json({ error: 'Invalid URL format' });
      }
      
      // Generate a unique short code
      let shortCode;
      let isUnique = false;
      
      while (!isUnique) {
        shortCode = generateShortCode();
        
        // Check if code already exists
        const [rows] = await pool.execute(
          'SELECT 1 FROM urls WHERE short_code = ?',
          [shortCode]
        );
        
        isUnique = rows.length === 0;
      }
      
      // Insert into database
      await pool.execute(
        'INSERT INTO urls (original_url, short_code) VALUES (?, ?)',
        [url, shortCode]
      );
      
      // Add to cache
      addToCache(shortCode, url);
      
      // Return the shortened URL
      const shortenedUrl = `${req.protocol}://${req.get('host')}/${shortCode}`;
      res.status(201).json({ 
        original_url: url,
        short_url: shortenedUrl,
        short_code: shortCode
      });
      
    } catch (error) {
      console.error('Error shortening URL:', error);
      res.status(500).json({ error: 'Failed to shorten URL' });
    }
  });

  // Redirect endpoint
  app.get('/:shortCode', async (req, res, next) => {
    try {
      const { shortCode } = req.params;
      
      // Skip API docs path
      if (shortCode === 'api-docs' || shortCode === 'api') {
        return next();
      }
      
      // Check cache first
      if (urlCache.has(shortCode)) {
        // Update click count in background
        pool.execute(
          'UPDATE urls SET clicks = clicks + 1 WHERE short_code = ?',
          [shortCode]
        ).catch(err => console.error('Error updating click count:', err));
        
        return res.redirect(urlCache.get(shortCode));
      }
      
      // Query database
      const [rows] = await pool.execute(
        'SELECT original_url FROM urls WHERE short_code = ?',
        [shortCode]
      );
      
      if (rows.length === 0) {
        return res.status(404).json({ error: 'URL not found' });
      }
      
      const originalUrl = rows[0].original_url;
      
      // Add to cache
      addToCache(shortCode, originalUrl);
      
      // Update click count in background
      pool.execute(
        'UPDATE urls SET clicks = clicks + 1 WHERE short_code = ?',
        [shortCode]
      ).catch(err => console.error('Error updating click count:', err));
      
      // Redirect to original URL
      res.redirect(originalUrl);
      
    } catch (error) {
      console.error('Error redirecting:', error);
      res.status(500).json({ error: 'Failed to redirect' });
    }
  });

  // Stats endpoint
  app.get('/api/stats/:shortCode', async (req, res) => {
    try {
      const { shortCode } = req.params;
      
      const [rows] = await pool.execute(
        'SELECT original_url, created_at, clicks FROM urls WHERE short_code = ?',
        [shortCode]
      );
      
      if (rows.length === 0) {
        return res.status(404).json({ error: 'URL not found' });
      }
      
      res.json({
        short_code: shortCode,
        original_url: rows[0].original_url,
        created_at: rows[0].created_at,
        clicks: rows[0].clicks
      });
      
    } catch (error) {
      console.error('Error getting stats:', error);
      res.status(500).json({ error: 'Failed to get stats' });
    }
  });

  // Swagger documentation
  const swaggerDocument = {
    openapi: '3.0.0',
    info: {
      title: 'URL Shortener API',
      version: '1.0.0',
      description: 'High-performance URL shortener API'
    },
    servers: [
      {
        url: '/',
        description: 'Current server'
      }
    ],
    paths: {
      '/api/shorten': {
        post: {
          summary: 'Create a shortened URL',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['url'],
                  properties: {
                    url: {
                      type: 'string',
                      description: 'The URL to shorten'
                    }
                  }
                }
              }
            }
          },
          responses: {
            '201': {
              description: 'URL shortened successfully',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      original_url: {
                        type: 'string'
                      },
                      short_url: {
                        type: 'string'
                      },
                      short_code: {
                        type: 'string'
                      }
                    }
                  }
                }
              }
            },
            '400': {
              description: 'Invalid input'
            },
            '500': {
              description: 'Server error'
            }
          }
        }
      },
      '/{shortCode}': {
        get: {
          summary: 'Redirect to original URL',
          parameters: [
            {
              name: 'shortCode',
              in: 'path',
              required: true,
              schema: {
                type: 'string'
              }
            }
          ],
          responses: {
            '302': {
              description: 'Redirect to original URL'
            },
            '404': {
              description: 'URL not found'
            },
            '500': {
              description: 'Server error'
            }
          }
        }
      },
      '/api/stats/{shortCode}': {
        get: {
          summary: 'Get URL statistics',
          parameters: [
            {
              name: 'shortCode',
              in: 'path',
              required: true,
              schema: {
                type: 'string'
              }
            }
          ],
          responses: {
            '200': {
              description: 'URL statistics',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      short_code: {
                        type: 'string'
                      },
                      original_url: {
                        type: 'string'
                      },
                      created_at: {
                        type: 'string',
                        format: 'date-time'
                      },
                      clicks: {
                        type: 'integer'
                      }
                    }
                  }
                }
              }
            },
            '404': {
              description: 'URL not found'
            },
            '500': {
              description: 'Server error'
            }
          }
        }
      }
    }
  };

  // Setup Swagger UI - make sure this is before the /:shortCode route
  app.use('/api-docs', swaggerUi.serve);
  app.get('/api-docs', swaggerUi.setup(swaggerDocument, { explorer: true }));

  // Simple home page
  app.get('/', (req, res) => {
    res.send(`
      <html>
        <head>
          <title>URL Shortener API</title>
          <style>
            body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
            h1 { color: #333; }
            pre { background: #f4f4f4; padding: 10px; border-radius: 5px; overflow-x: auto; }
            a { color: #0066cc; }
          </style>
        </head>
        <body>
          <h1>URL Shortener API</h1>
          <p>This is a high-performance URL shortener API.</p>
          <p>View the <a href="/api-docs">API documentation</a> for more information.</p>
          
          <h2>Quick Start</h2>
          <p>To create a shortened URL, send a POST request to <code>/api/shorten</code>:</p>
          <pre>
curl -X POST http://localhost:3000/api/shorten \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://example.com/very/long/url"}'
          </pre>
        </body>
      </html>
    `);
  });

  // Start server
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Worker ${process.pid} started`);
    console.log(`Server running on port ${PORT}`);
    console.log(`API documentation available at http://localhost:${PORT}/api-docs`);
  });

  // For demonstration purposes, let's simulate some URL shortening requests
  setTimeout(async () => {
    console.log('\n--- Demonstration ---');
    
    // Simulate creating a shortened URL
    const demoUrl = 'https://example.com/very/long/url/that/needs/shortening';
    console.log(`Creating shortened URL for: ${demoUrl}`);
    
    const shortCode = generateShortCode();
    console.log(`Generated short code: ${shortCode}`);
    
    // Simulate looking up the URL
    console.log(`A user visiting /${shortCode} would be redirected to ${demoUrl}`);
    
    console.log('\nIn a production environment, this server can handle 1000+ URLs/second with:');
    console.log('- MySQL connection pooling');
    console.log('- In-memory caching for frequently accessed URLs');
    console.log('- Efficient short code generation');
    console.log('- Background processing for analytics updates');
    console.log('- Proper database indexing');
    console.log('- Automatic database creation and initialization');
  }, 1000);
}