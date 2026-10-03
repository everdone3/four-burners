export const FUNCTIONS: Record<'notify' | 'shortcuts' | 'calendar', { entry: string; about: string; from: string }>;
export function outputOf(name: 'notify' | 'shortcuts' | 'calendar'): string;
export const OUTPUT: string;
export function bundleFunction(name: 'notify' | 'shortcuts' | 'calendar'): Promise<string>;
export function bundleNotify(): Promise<string>;
