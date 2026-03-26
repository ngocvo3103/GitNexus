/**
 * Shared module that provides common functionality.
 */
export class SharedModule {
    /**
     * Processes the input data.
     * @param input the input string
     * @returns the processed result
     */
    process(input: string): string {
        return input.toUpperCase();
    }
}

/**
 * Helper function for utility operations.
 * @param data the input data
 * @returns the transformed data
 */
export function helper(data: string): string {
    return data.trim();
}