"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTimeSince = getTimeSince;
exports.parseMultiplexedLogs = parseMultiplexedLogs;
exports.parseLine = parseLine;
exports.createLogViewer = createLogViewer;
/**
 * Log Viewer Module
 *
 * Provides container log retrieval, real-time log streaming via Socket.IO,
 * search filtering, and time range filtering with stdout/stderr distinction.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7
 */
const dockerode_1 = __importDefault(require("dockerode"));
// ─── Constants ─────────────────────────────────────────────────────────────────
const DEFAULT_TAIL_LINES = 500;
const MAX_SEARCH_LENGTH = 200;
const MIN_SEARCH_LENGTH = 1;
/**
 * Docker multiplexed stream header format:
 * - Byte 0: stream type (1 = stdout, 2 = stderr)
 * - Bytes 1-3: padding (zeros)
 * - Bytes 4-7: payload size (big-endian uint32)
 * Total header size: 8 bytes
 */
const DOCKER_STREAM_HEADER_SIZE = 8;
// ─── Helpers ───────────────────────────────────────────────────────────────────
/**
 * Get the "since" timestamp for a given time range relative to now.
 */
function getTimeSince(range, now) {
    const reference = now ?? new Date();
    const nowSec = Math.floor(reference.getTime() / 1000);
    switch (range) {
        case '1h':
            return nowSec - 3600;
        case '6h':
            return nowSec - 21600;
        case '24h':
            return nowSec - 86400;
        case 'all':
            return 0;
    }
}
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
function parseMultiplexedLogs(buffer, hasTimestamps) {
    const entries = [];
    let offset = 0;
    while (offset < buffer.length) {
        // Need at least the header
        if (offset + DOCKER_STREAM_HEADER_SIZE > buffer.length)
            break;
        const streamType = buffer[offset];
        const payloadSize = buffer.readUInt32BE(offset + 4);
        offset += DOCKER_STREAM_HEADER_SIZE;
        if (offset + payloadSize > buffer.length)
            break;
        const payload = buffer.subarray(offset, offset + payloadSize).toString('utf-8');
        offset += payloadSize;
        const stream = streamType === 2 ? 'stderr' : 'stdout';
        // Split payload into lines (Docker may batch multiple lines in one frame)
        const lines = payload.split('\n').filter((line) => line.length > 0);
        for (const line of lines) {
            const entry = parseLine(line, stream, hasTimestamps);
            if (entry) {
                entries.push(entry);
            }
        }
    }
    return entries;
}
/**
 * Parse a single log line into a LogEntry.
 * If timestamps are enabled, the line starts with an RFC3339 timestamp followed by a space.
 */
function parseLine(line, stream, hasTimestamps) {
    if (!line)
        return null;
    let timestamp;
    let content;
    if (hasTimestamps) {
        // Docker timestamp format: 2024-01-15T10:30:00.123456789Z
        // Find the first space after the timestamp
        const spaceIdx = line.indexOf(' ');
        if (spaceIdx > 0) {
            const tsStr = line.substring(0, spaceIdx);
            const parsed = new Date(tsStr);
            if (!isNaN(parsed.getTime())) {
                timestamp = parsed;
                content = line.substring(spaceIdx + 1);
            }
            else {
                timestamp = new Date();
                content = line;
            }
        }
        else {
            timestamp = new Date();
            content = line;
        }
    }
    else {
        timestamp = new Date();
        content = line;
    }
    return { timestamp, content, stream };
}
// ─── Implementation ────────────────────────────────────────────────────────────
function createLogViewer(config) {
    const dockerHost = config?.dockerHost ?? process.env.DOCKER_HOST ?? '/var/run/docker.sock';
    const io = config?.io;
    // Initialize Docker client
    const dockerOpts = dockerHost.startsWith('/')
        ? { socketPath: dockerHost }
        : { host: dockerHost };
    const docker = new dockerode_1.default(dockerOpts);
    // Track active log streams for cleanup
    const activeStreams = new Map();
    // ─── getContainerLogs ──────────────────────────────────────────────────
    async function getContainerLogs(containerId, options) {
        const tail = options?.tail ?? DEFAULT_TAIL_LINES;
        const timeRange = options?.timeRange ?? 'all';
        const timestamps = options?.timestamps ?? true;
        const container = docker.getContainer(containerId);
        // Build Docker logs options
        const logsOptions = {
            stdout: true,
            stderr: true,
            tail,
            timestamps,
            follow: false,
        };
        // Apply time range filter using Docker's "since" parameter
        if (timeRange !== 'all') {
            logsOptions.since = getTimeSince(timeRange);
        }
        // Retrieve logs - returns a Buffer for non-TTY containers (multiplexed)
        const logOutput = await container.logs(logsOptions);
        // Handle case where logs might be a string (TTY mode) or Buffer (multiplexed)
        if (typeof logOutput === 'string') {
            // TTY mode: logs are plain text, no multiplexing headers
            const lines = logOutput.split('\n').filter((l) => l.length > 0);
            return lines.map((line) => {
                const entry = parseLine(line, 'stdout', timestamps);
                return entry ?? { timestamp: new Date(), content: line, stream: 'stdout' };
            });
        }
        // Ensure we have a Buffer
        const buffer = Buffer.isBuffer(logOutput) ? logOutput : Buffer.from(logOutput);
        return parseMultiplexedLogs(buffer, timestamps);
    }
    // ─── startLogStream ────────────────────────────────────────────────────
    function startLogStream(containerId, socketRoom) {
        // Stop any existing stream for this container
        stopLogStream(containerId);
        if (!io) {
            throw new Error('Socket.IO server not configured for log streaming');
        }
        const container = docker.getContainer(containerId);
        // Start following logs from now
        container.logs({
            stdout: true,
            stderr: true,
            follow: true,
            since: Math.floor(Date.now() / 1000),
            timestamps: true,
        }, (err, rawStream) => {
            if (err || !rawStream) {
                io.to(socketRoom).emit('log:error', {
                    containerId,
                    error: err?.message ?? 'Failed to start log stream',
                });
                return;
            }
            // At runtime, Docker returns a ReadableStream when follow=true
            const stream = rawStream;
            // Store the stream reference for cleanup
            activeStreams.set(containerId, {
                destroy: () => {
                    stream.removeAllListeners();
                    if (stream.destroy) {
                        stream.destroy();
                    }
                },
            });
            // Buffer for partial frames
            let partialBuffer = Buffer.alloc(0);
            stream.on('data', (chunk) => {
                // Combine with any partial buffer from previous chunk
                const data = Buffer.concat([partialBuffer, chunk]);
                partialBuffer = Buffer.alloc(0);
                let offset = 0;
                while (offset < data.length) {
                    // Need at least the header
                    if (offset + DOCKER_STREAM_HEADER_SIZE > data.length) {
                        partialBuffer = data.subarray(offset);
                        break;
                    }
                    const streamType = data[offset];
                    const payloadSize = data.readUInt32BE(offset + 4);
                    offset += DOCKER_STREAM_HEADER_SIZE;
                    if (offset + payloadSize > data.length) {
                        // Incomplete frame, save for next chunk
                        partialBuffer = data.subarray(offset - DOCKER_STREAM_HEADER_SIZE);
                        break;
                    }
                    const payload = data.subarray(offset, offset + payloadSize).toString('utf-8');
                    offset += payloadSize;
                    const logStream = streamType === 2 ? 'stderr' : 'stdout';
                    // Parse lines from the payload
                    const lines = payload.split('\n').filter((l) => l.length > 0);
                    for (const line of lines) {
                        const entry = parseLine(line, logStream, true);
                        if (entry) {
                            io.to(socketRoom).emit('log:entry', {
                                containerId,
                                entry: {
                                    timestamp: entry.timestamp.toISOString(),
                                    content: entry.content,
                                    stream: entry.stream,
                                },
                            });
                        }
                    }
                }
            });
            stream.on('error', (streamErr) => {
                io.to(socketRoom).emit('log:error', {
                    containerId,
                    error: streamErr.message,
                });
            });
            stream.on('end', () => {
                io.to(socketRoom).emit('log:end', { containerId });
                activeStreams.delete(containerId);
            });
        });
    }
    // ─── stopLogStream ─────────────────────────────────────────────────────
    function stopLogStream(containerId) {
        const streamInfo = activeStreams.get(containerId);
        if (streamInfo) {
            streamInfo.destroy();
            activeStreams.delete(containerId);
        }
    }
    // ─── filterLogs ────────────────────────────────────────────────────────
    function filterLogs(logs, searchTerm) {
        // Validate search term length (1-200 characters)
        if (searchTerm.length < MIN_SEARCH_LENGTH || searchTerm.length > MAX_SEARCH_LENGTH) {
            return [];
        }
        const lowerSearch = searchTerm.toLowerCase();
        return logs.filter((entry) => entry.content.toLowerCase().includes(lowerSearch));
    }
    // ─── filterByTimeRange ─────────────────────────────────────────────────
    function filterByTimeRange(logs, range) {
        if (range === 'all') {
            return logs;
        }
        const sinceTimestamp = getTimeSince(range) * 1000; // Convert to milliseconds
        return logs.filter((entry) => entry.timestamp.getTime() >= sinceTimestamp);
    }
    // ─── Return the public API ─────────────────────────────────────────────
    return {
        getContainerLogs,
        startLogStream,
        stopLogStream,
        filterLogs,
        filterByTimeRange,
    };
}
//# sourceMappingURL=log-viewer.js.map