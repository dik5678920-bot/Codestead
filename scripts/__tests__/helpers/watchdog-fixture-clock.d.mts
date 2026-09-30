export function awaitWatchdogReady<T>(start: () => Promise<T>): Promise<T>;
export function controlWatchdogKillClock(): void;
export function advanceWatchdogKillClock(milliseconds: number): void;
