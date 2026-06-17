/**
 * Build Pipeline Module
 *
 * Git-based Docker image build pipeline:
 * - Clone/pull Git repositories via simple-git (SSH key or HTTPS token auth)
 * - Build Docker images using dockerode buildImage()
 * - Stream build output in real-time
 * - Tag images with configurable format (default: project:latest and project:YYYYMMDD-HHMMSS)
 * - Deploy by recreating containers preserving config (env, ports, volumes, networks, restart policy)
 * - Handle auth errors and build failures gracefully (abort without modifying existing containers)
 * - Pass build args as --build-arg
 * - Submit builds to Job Queue
 *
 * Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 19.7, 19.8
 */
import type Database from 'better-sqlite3';
import type { JobQueue } from './job-queue';
export interface PipelineConfig {
    repoUrl: string;
    authMethod: 'ssh-key' | 'https-token';
    authCredential: string;
    branch: string;
    dockerfilePath: string;
    buildContext: string;
    buildArgs: Record<string, string>;
    tagFormat: string;
    targetContainer: string;
}
export interface BuildRecord {
    id: string;
    projectId: string;
    jobId: string;
    status: 'queued' | 'running' | 'completed' | 'failed';
    imageTag: string;
    branch: string;
    commitSha?: string;
    startedAt?: Date;
    completedAt?: Date;
    duration?: number;
    error?: string;
}
export interface BuildPipeline {
    /** Configure a build pipeline for a project. */
    configurePipeline(projectId: string, config: PipelineConfig): Promise<void>;
    /** Trigger a build for a project. Returns the job ID. */
    triggerBuild(projectId: string): Promise<string>;
    /** Get build history for a project. */
    getBuildHistory(projectId: string): Promise<BuildRecord[]>;
    /** Get the pipeline configuration for a project (or null if not configured). */
    getPipelineConfig(projectId: string): Promise<PipelineConfig | null>;
}
export interface BuildPipelineConfig {
    /** Docker host (socket path or URL). Default: /var/run/docker.sock */
    dockerHost?: string;
    /** Base directory for cloned repos. Default: /tmp/vps-panel-builds */
    workDir?: string;
    /** Job queue instance for submitting build jobs. */
    jobQueue?: JobQueue;
}
export declare function createBuildPipeline(db: Database.Database, config?: BuildPipelineConfig): BuildPipeline;
//# sourceMappingURL=build-pipeline.d.ts.map