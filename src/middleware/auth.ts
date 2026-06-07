/**
 * Authentication Middleware
 *
 * Express middleware and Socket.IO middleware for session validation.
 * - Express: Checks Authorization header (Bearer token) or session cookie.
 *   Redirects browser requests to login page or returns 401 for API requests.
 *   Updates last_activity on valid sessions.
 * - Socket.IO: Validates token in handshake auth/headers. Rejects if invalid.
 */
import type { Request, Response, NextFunction } from 'express';
import type { Socket } from 'socket.io';
import type { AuthModule, Session } from '../modules/auth.js';

// Extend Express Request to include session
declare global {
  namespace Express {
    interface Request {
      session?: Session;
    }
  }
}

// --- Helpers ---

/**
 * Extract the bearer token from an Express request.
 * Checks Authorization header first, then falls back to cookie.
 */
function extractTokenFromRequest(req: Request): string | null {
  // Check Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  // Check cookie
  const cookies = req.headers.cookie;
  if (cookies) {
    const tokenCookie = cookies
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith('session_token='));
    if (tokenCookie) {
      return tokenCookie.split('=')[1] ?? null;
    }
  }

  return null;
}

/**
 * Determine if a request is likely from a browser (expects HTML)
 * vs an API client (expects JSON).
 */
function isBrowserRequest(req: Request): boolean {
  const accept = req.headers.accept ?? '';
  return accept.includes('text/html');
}

// --- Express Middleware ---

export interface AuthMiddlewareOptions {
  loginPath?: string;
  publicPaths?: string[];
}

/**
 * Create Express authentication middleware.
 *
 * Protected routes require a valid session token.
 * Unauthenticated browser requests redirect to login page.
 * Unauthenticated API requests get 401.
 */
export function createAuthMiddleware(
  authModule: AuthModule,
  options?: AuthMiddlewareOptions
) {
  const loginPath = options?.loginPath ?? '/login';
  const publicPaths = options?.publicPaths ?? ['/health', '/login', '/api/auth/login'];

  return function authMiddleware(req: Request, res: Response, next: NextFunction): void {
    // Allow public paths through without auth
    if (publicPaths.some((p) => req.path === p || req.path.startsWith(p + '/'))) {
      next();
      return;
    }

    const token = extractTokenFromRequest(req);

    if (!token) {
      if (isBrowserRequest(req)) {
        res.redirect(loginPath);
      } else {
        res.status(401).json({ error: 'Authentication required' });
      }
      return;
    }

    const session = authModule.validateSession(token);

    if (!session) {
      if (isBrowserRequest(req)) {
        res.redirect(loginPath);
      } else {
        res.status(401).json({ error: 'Invalid or expired session' });
      }
      return;
    }

    // Attach session to request for downstream handlers
    req.session = session;
    next();
  };
}

// --- Socket.IO Middleware ---

/**
 * Extract token from Socket.IO handshake.
 * Checks auth object first, then Authorization header.
 */
function extractTokenFromHandshake(socket: Socket): string | null {
  // Check auth object (socket.io client auth)
  const authToken = socket.handshake.auth?.token as string | undefined;
  if (authToken) {
    return authToken;
  }

  // Check Authorization header in handshake
  const authHeader = socket.handshake.headers?.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  // Check cookie in handshake headers
  const cookies = socket.handshake.headers?.cookie;
  if (cookies) {
    const tokenCookie = cookies
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith('session_token='));
    if (tokenCookie) {
      return tokenCookie.split('=')[1] ?? null;
    }
  }

  return null;
}

/**
 * Create Socket.IO authentication middleware.
 *
 * Validates token from handshake auth or headers.
 * Rejects connection if token is missing or invalid.
 */
export function createSocketAuthMiddleware(authModule: AuthModule) {
  return function socketAuthMiddleware(
    socket: Socket,
    next: (err?: Error) => void
  ): void {
    const token = extractTokenFromHandshake(socket);

    if (!token) {
      next(new Error('Authentication required'));
      return;
    }

    const session = authModule.validateSession(token);

    if (!session) {
      next(new Error('Invalid or expired session'));
      return;
    }

    // Attach session data to socket for downstream use
    (socket as any).session = session;
    next();
  };
}
