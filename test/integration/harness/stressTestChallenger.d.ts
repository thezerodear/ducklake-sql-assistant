interface TestResult {
    name: string;
    passed: boolean;
    error?: string;
    details?: any;
}
export declare function runStressTest(): Promise<{
    passed: boolean;
    results: TestResult[];
}>;
export {};
