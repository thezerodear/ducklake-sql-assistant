export interface ProcessNode {
    ProcessId: number;
    ParentProcessId: number;
    CommandLine: string;
}
export interface StressSummary {
    rapidCyclesPassed: boolean;
    rapidCycleDetails: Array<{
        cycle: number;
        postmasterPid: number;
        childrenCount: number;
        startMs: number;
        stopMs: number;
        lingeringInTree: number;
    }>;
    portConflictTcpPassed: boolean;
    portConflictDuplicatePassed: boolean;
    crashRecoveryPassed: boolean;
    globalLingeringCount: number;
    overallApproved: boolean;
}
export declare function runStressSuite(): Promise<StressSummary>;
