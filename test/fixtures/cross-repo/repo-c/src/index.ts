import { SharedModule, helper } from 'shared-npm-lib';

/**
 * Main entry point for the application.
 */
export function main(): void {
    const module = new SharedModule();
    const result = module.process('input');
    console.log(result);
}

export function processData(data: string): string {
    return helper(data);
}