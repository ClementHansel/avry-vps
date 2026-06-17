import type { Server as SocketIOServer } from 'socket.io';
export type LogStream = 'stdout' | 'stderr';
export type TimeRange = '1h' | '6h' | '24h' | 'all';
export interface LogEntry {
    timestamp: Date;
    content: string;
    stream: LogStream;
}
export interface GetLogsOptions {
    /** Number of lines to retrieve. Default: 500 */
    tail?: number;
    /** Time range filter */
    timeRange?: TimeRange;
    /** Whether to include timestamps from Docker. Default: true */
    timestamps?: boolean;
}
export interface LogViewer {
    /** Retrieve last N lines of container logs with stdout/stderr distinction */
    getContainerLogs(containerId: string, options?: GetLogsOptions): Promise<LogEntry[]>;
    /** Start streaming new log entries in real-time to a Socket.IO room */
    startLogStream(containerId: string, socketRoom: string): void;
    /** Stop streaming for a container */
    stopLogStream(containerId: string): void;
    /** Filter log entries by search term (case-insensitive, 1-200 chars) */
    filterLogs(logs: LogEntry[], searchTerm: string): LogEntry[];
    /** Filter log entries by time range */
    filterByTimeRange(logs: LogEntry[], range: TimeRange): LogEntry[];
}
export interface LogViewerConfig {
    /** Docker host URI. Defaults to DOCKER_HOST env or /var/run/docker.sock */
    dockerHost?: string;
    /** Socket.IO server instance for real-time streaming */
    io?: SocketIOServer;
}
/**
 * Get the "since" timestamp for a given time range relative to now.
 */
export declare function getTimeSince(range: TimeRange, now?: Date): number;
/**
 * Parse Docker multiplexed log output into LogEntry objects.
 *
 * Docker container logs in "multiplexed" mode have 8-byte headers:
 * - Byte 0: 1 = stdout, 2 = stderr
 * - Bytes 4-7: payload length (big-endian)
 * - Followed by the payload bytes
 *
 * When timestamps are enabled, the payload starts with an RFC3339 timestamp.
 */
export declare function parseMultiplexedLogs(buffer: Buffer, hasTimestamps: boolean): LogEntry[];
/**
 * Parse a single log line into a LogEntry.
 * If timestamps are enabled, the line starts with an RFC3339 timestamp followed by a space.
 */
export declare function parseLine(line: string, stream: LogStream, hasTimestamps: boolean): LogEntry | null;
export declare function createLogViewer(config?: LogViewerConfig): LogViewer;
//# sourceMappingURL=log-viewer.d.ts.map