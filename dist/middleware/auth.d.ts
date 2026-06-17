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
declare global {
    namespace Express {
        interface Request {
            session?: Session;
        }
    }
}
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
export declare function createAuthMiddleware(authModule: AuthModule, options?: AuthMiddlewareOptions): (req: Request, res: Response, next: NextFunction) => void;
/**
 * Create Socket.IO authentication middleware.
 *
 * Validates token from handshake auth or headers.
 * Rejects connection if token is missing or invalid.
 */
export declare function createSocketAuthMiddleware(authModule: AuthModule): (socket: Socket, next: (err?: Error) => void) => void;
//# sourceMappingURL=auth.d.ts.map