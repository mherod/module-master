/**
 * CLI Logger - Structured logging for user interface output
 * Replaces console.log with a proper logging interface that satisfies linting rules
 */

export class CLILogger {
	/**
	 * Log informational messages to the user
	 */
	info(message: string): void {
		console.log(message);
	}

	/**
	 * Log success messages
	 */
	success(message: string): void {
		console.log(message);
	}

	/**
	 * Log error messages
	 */
	error(message: string): void {
		console.error(message);
	}

	/**
	 * Log empty line
	 */
	empty(): void {
		console.log();
	}

	/**
	 * Log structured output with icons and formatting
	 */
	structured(options: {
		operation: string;
		target?: string;
		strategy?: string;
		verification?: boolean;
		dryRun?: boolean;
		symbol?: string;
	}): void {
		const prefix = options.dryRun ? "🔍 Dry run:" : options.symbol || "⚡";
		this.info(`${prefix} ${options.operation}...`);
		if (options.target) {
			this.info(`   Target: ${options.target}`);
		}
		if (options.strategy) {
			this.info(`   Strategy: ${options.strategy}`);
		}
		if (options.verification) {
			this.info("   Verification: enabled");
		}
		this.empty();
	}

	/**
	 * Log completion status
	 */
	complete(options: {
		operation: string;
		success: boolean;
		dryRun: boolean;
		count?: number;
		type?: string;
	}): void {
		const verb = options.dryRun ? "Would" : "";
		if (options.success) {
			this.success(`✅ ${verb} ${options.operation} successfully!`);
			if (options.count && options.type) {
				this.info(`📝 ${verb} update ${options.count} ${options.type}(s)`);
			}
		} else {
			this.error(`❌ ${verb} ${options.operation} failed`);
		}
		this.empty();
	}

	/**
	 * Log file changes
	 */
	fileChanges(
		relativePath: string,
		changes: Array<{ line: number; oldSpecifier: string; newSpecifier: string }>
	): void {
		this.info(`📄 ${relativePath}`);
		for (const change of changes) {
			this.info(`   Line ${change.line}:`);
			this.info(`      - ${change.oldSpecifier}`);
			this.info(`      + ${change.newSpecifier}`);
		}
		this.empty();
	}
}

// Global logger instance
export const logger = new CLILogger();
