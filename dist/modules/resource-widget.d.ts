export interface SystemMetrics {
    cpu: {
        usagePercent: number;
        warning: boolean;
    };
    memory: {
        usedGB: number;
        totalGB: number;
        usagePercent: number;
        warning: boolean;
    };
    disk: {
        usedGB: number;
        totalGB: number;
        usagePercent: number;
        warning: boolean;
    };
    network: {
        inBytesPerSec: number;
        outBytesPerSec: number;
    };
    procAvailable: boolean;
}
export interface ContainerMetrics {
    id: string;
    name: string;
    cpuPercent: number;
    memoryMB: number;
    warning: boolean;
}
export interface ResourceUpdate {
    system: SystemMetrics;
    containers: ContainerMetrics[];
    timestamp: number;
    warnings: string[];
}
export interface ResourceWidget {
    getSystemMetrics(): Promise<SystemMetrics>;
    getContainerMetrics(): Promise<ContainerMetrics[]>;
    startMonitoring(io: SocketIOServer): void;
    stopMonitoring(): void;
    /** Get the latest cached update (useful for tests) */
    getLatestUpdate(): ResourceUpdate | null;
    /** Check if /proc filesystem is accessible */
    isProcAvailable(): Promise<boolean>;
}
export interface ResourceWidgetConfig {
    /** Docker host URI. Defaults to DOCKER_HOST env or /var/run/docker.sock */
    dockerHost?: string;
    /** Update interval in ms. Default: 5000 (5 seconds) */
    updateIntervalMs?: number;
    /** Warning threshold percentage. Default: 90 */
    warningThreshold?: number;
    /** Custom proc path for testing. Default: /proc */
    procPath?: string;
}
/** Minimal Socket.IO Server interface for dependency injection */
export interface SocketIOServer {
    emit(event: string, data: any): void;
}
export declare function createResourceWidget(config?: ResourceWidgetConfig): ResourceWidget;
//# sourceMappingURL=resource-widget.d.ts.map