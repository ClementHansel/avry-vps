export type ContainerStatus = 'running' | 'stopped' | 'exited' | 'restarting';
export type HealthStatus = 'healthy' | 'unhealthy' | 'unknown';
export interface ContainerInfo {
    id: string;
    name: string;
    image: string;
    port: number;
    status: ContainerStatus;
    health: HealthStatus;
    uptime: number;
    projectId?: string;
}
export interface ContainerDetail extends ContainerInfo {
    containerId: string;
    imageTag: string;
    restartCount: number;
    cpuUsagePercent: number;
    memoryUsageMB: number;
    env: string[];
    ports: PortMapping[];
    volumes: VolumeMount[];
    networks: string[];
    restartPolicy: RestartPolicy;
}
export interface PortMapping {
    hostPort: number;
    containerPort: number;
    protocol: string;
}
export interface VolumeMount {
    source: string;
    destination: string;
    mode: string;
}
export interface RestartPolicy {
    name: string;
    maximumRetryCount: number;
}
export interface ContainerStats {
    cpuUsagePercent: number;
    memoryUsageMB: number;
    memoryLimitMB: number;
    networkRxBytes: number;
    networkTxBytes: number;
    blockReadBytes: number;
    blockWriteBytes: number;
}
export interface ContainerManager {
    listContainers(): Promise<ContainerInfo[]>;
    getContainer(id: string): Promise<ContainerDetail>;
    startContainer(id: string): Promise<void>;
    stopContainer(id: string): Promise<void>;
    restartContainer(id: string): Promise<void>;
    pullAndRedeploy(id: string): Promise<string>;
    getContainerStats(id: string): Promise<ContainerStats>;
    getHealthStatus(id: string): Promise<HealthStatus>;
    /** Start the health polling interval */
    startHealthPolling(): void;
    /** Stop the health polling interval */
    stopHealthPolling(): void;
    /** Get the cached health statuses */
    getHealthCache(): Map<string, HealthStatus>;
    /** Get the circuit breaker state */
    getCircuitBreakerState(): CircuitBreakerState;
}
export interface ContainerManagerConfig {
    /** Docker host URI. Defaults to DOCKER_HOST env or /var/run/docker.sock */
    dockerHost?: string;
    /** Health poll interval in ms. Default: 15000 (15 seconds) */
    healthPollIntervalMs?: number;
    /** Health check timeout in ms. Default: 5000 (5 seconds) */
    healthCheckTimeoutMs?: number;
    /** Circuit breaker failure threshold. Default: 5 */
    circuitBreakerThreshold?: number;
    /** Circuit breaker reset timeout in ms. Default: 30000 (30 seconds) */
    circuitBreakerResetMs?: number;
    /** Callback when a job is submitted (for pullAndRedeploy) */
    onJobSubmit?: (jobId: string, containerId: string) => void;
}
export type CircuitBreakerStateType = 'closed' | 'open' | 'half-open';
export interface CircuitBreakerState {
    state: CircuitBreakerStateType;
    failures: number;
    lastFailureTime: number | null;
    nextRetryTime: number | null;
}
export declare function createContainerManager(config?: ContainerManagerConfig): ContainerManager;
//# sourceMappingURL=container-manager.d.ts.map