export const FUNCTIONS: Record<'notify' | 'shortcuts', { entry: string; about: string; from: string }>;
export function outputOf(name: 'notify' | 'shortcuts'): string;
export const OUTPUT: string;
export function bundleFunction(name: 'notify' | 'shortcuts'): Promise<string>;
export function bundleNotify(): Promise<string>;
