/**
 * Uptime formatting and parsing utilities.
 * Converts seconds to human-readable "Xd Xh Xm" format and back.
 */

/**
 * Formats a duration in seconds to a human-readable string.
 * Output format: "Xd Xh Xm" with zero-value components omitted.
 * Seconds are rounded to the nearest minute before formatting.
 *
 * @param seconds - The duration in seconds (negative values treated as 0)
 * @returns A formatted string like "2d 3h 45m", "5h 30m", or "0m"
 */
export function formatUptime(seconds: number): string {
  // Treat negative or NaN as 0
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '0m';
  }

  // Round to nearest minute
  const totalMinutes = Math.round(seconds / 60);

  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  const parts: string[] = [];

  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0 || parts.length === 0) {
    parts.push(`${minutes}m`);
  }

  return parts.join(' ');
}

/**
 * Parses a formatted uptime string back to seconds.
 * Accepts strings in the format "Xd Xh Xm" (any combination).
 *
 * @param formatted - The formatted uptime string
 * @returns The duration in seconds (rounded to nearest minute)
 */
export function parseUptime(formatted: string): number {
  if (!formatted || typeof formatted !== 'string') {
    return 0;
  }

  let totalMinutes = 0;

  const dayMatch = formatted.match(/(\d+)d/);
  const hourMatch = formatted.match(/(\d+)h/);
  const minuteMatch = formatted.match(/(\d+)m/);

  if (dayMatch) {
    totalMinutes += parseInt(dayMatch[1], 10) * 24 * 60;
  }
  if (hourMatch) {
    totalMinutes += parseInt(hourMatch[1], 10) * 60;
  }
  if (minuteMatch) {
    totalMinutes += parseInt(minuteMatch[1], 10);
  }

  return totalMinutes * 60;
}
