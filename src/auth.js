import crypto from 'node:crypto';
import express from 'express';

export function requireAuthEnv(env = process.env) {
  const missing = [];
  if (!env.APP_PASSWORD) missing.push('APP_PASSWORD');
  if (!env.SESSION_SECRET) missing.push('SESSION_SECRET');
  if (env.SESSION_SECRET && env.SESSION_SECRET.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters long.');
  }
  if (missing.length > 0) {
    throw new Error(`Missing required authentication environment variable(s): ${missing.join(', ')}`);
  }
}

export function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length) {
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

export function requireLogin(req, res, next) {
  if (req.session?.authenticated === true) {
    next();
    return;
  }

  if (req.accepts('html')) {
    res.redirect('/login');
    return;
  }

  res.status(401).json({ error: 'Authentication required.' });
}

export function authRouter({ appPassword }) {
  const router = express.Router();

  router.get('/login', (req, res) => {
    if (req.session?.authenticated === true) {
      res.redirect('/');
      return;
    }
    res.sendFile('login.html', { root: 'public' });
  });

  router.post('/login', express.urlencoded({ extended: false }), (req, res) => {
    const password = req.body?.password ?? '';
    if (!timingSafeEqualString(password, appPassword)) {
      res.status(401).sendFile('login.html', { root: 'public' });
      return;
    }

    req.session.regenerate((regenerateError) => {
      if (regenerateError) {
        res.status(500).send('Could not create a login session.');
        return;
      }
      req.session.authenticated = true;
      res.redirect('/');
    });
  });

  router.post('/logout', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('geggamoja.sid');
      res.redirect('/login');
    });
  });

  return router;
}
