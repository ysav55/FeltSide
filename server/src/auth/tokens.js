import jwt from 'jsonwebtoken';

export function signToken(player, config) {
  return jwt.sign(
    { sub: player.id, role: player.role },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );
}

export function verifyToken(token, config) {
  return jwt.verify(token, config.jwtSecret); // throws on invalid/expired
}
