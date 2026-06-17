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
export declare function formatUptime(seconds: number): string;
/**
 * Parses a formatted uptime string back to seconds.
 * Accepts strings in the format "Xd Xh Xm" (any combination).
 *
 * @param formatted - The formatted uptime string
 * @returns The duration in seconds (rounded to nearest minute)
 */
export declare function parseUptime(formatted: string): number;
//# sourceMappingURL=format-uptime.d.ts.map