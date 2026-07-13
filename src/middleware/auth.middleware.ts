import type { Request, RequestHandler } from 'express'
import jwt from 'jsonwebtoken'

interface AuthPayload {
  id: number
  role: string
}

// Use this type in route handlers that run after authenticate + requireAdmin
export interface AuthenticatedRequest extends Request {
  user: AuthPayload
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload
    }
  }
}

function isAuthPayload(value: unknown): value is AuthPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).id === 'number' &&
    typeof (value as Record<string, unknown>).role === 'string'
  )
}

export const authenticate: RequestHandler = (req, res, next) => {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'No autorizado' })
    return
  }

  const secret = process.env.JWT_SECRET
  if (!secret) {
    res.status(500).json({ error: 'JWT_SECRET no configurado' })
    return
  }

  const token = header.slice('Bearer '.length)
  try {
    const payload = jwt.verify(token, secret)
    if (!isAuthPayload(payload)) {
      res.status(401).json({ error: 'Token inválido o expirado' })
      return
    }
    req.user = { id: payload.id, role: payload.role }
    next()
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' })
  }
}

export const requireAdmin: RequestHandler = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Requiere rol admin' })
    return
  }
  next()
}
