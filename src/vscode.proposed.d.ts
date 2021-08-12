/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * This is the place for API experiments and proposals.
 * These API are NOT stable and subject to change. They are only available in the Insiders
 * distribution and CANNOT be used in published extensions.
 *
 * To test these API in local environment:
 * - Use Insiders release of 'VS Code'.
 * - Add `"enableProposedApi": true` to your package.json.
 * - Copy this file to your project.
 */

declare module 'vscode' {
	//#region non-error test output https://github.com/microsoft/vscode/issues/129201
	interface TestRun {
		/**
		 * Appends raw output from the test runner. On the user's request, the
		 * output will be displayed in a terminal. ANSI escape sequences,
		 * such as colors and text styles, are supported.
		 *
		 * @param output Output text to append.
		 * @param location Indicate that the output was logged at the given
		 * location.
		 * @param test Test item to associate the output with.
		 */
		appendOutput(output: string, location?: Location, test?: TestItem): void;
	}
	//#endregion

	//#region test tags https://github.com/microsoft/vscode/issues/129456
	/**
	 * Tags can be associated with {@link TestItem | TestItems} and
	 * {@link TestRunProfile | TestRunProfiles}. A profile with a tag can only
	 * execute tests that include that tag in their {@link TestItem.tags} array.
	 */
	export class TestTag {
		/**
		 * Unique ID of the test tag.
		 */
		readonly id: string;

		/**
		 * Human-readable name of the tag. If present, the tag will be visible as
		 * a filter option in the UI.
		 */
		readonly label?: string;

		/**
		 * Creates a new TestTag instance.
		 * @param id Unique ID of the test tag.
		 * @param label Human-readable name of the tag.  If present, the tag will
		 * be visible as a filter option in the UI.
		 */
		constructor(id: string, label?: string);
	}

	export interface TestRunProfile {
		/**
		 * Associated tag for the profile. If this is set, only {@link TestItem}
		 * instances with the same tag will be eligible to execute in this profile.
		 */
		tag?: TestTag;
	}

	export interface TestItem {
		/**
		 * Tags associated with this test item. May be used in combination with
		 * {@link TestRunProfile.tags}, or simply as an organizational feature.
		 */
		tags: readonly TestTag[];
	}

	export interface TestController {
		createRunProfile(
			label: string,
			kind: TestRunProfileKind,
			runHandler: (request: TestRunRequest, token: CancellationToken) => Thenable<void> | void,
			isDefault?: boolean,
			tag?: TestTag
		): TestRunProfile;
	}

	//#endregion

	//#region proposed test APIs https://github.com/microsoft/vscode/issues/107467
	export namespace tests {
		/**
		 * Requests that tests be run by their controller.
		 * @param run Run options to use.
		 * @param token Cancellation token for the test run
		 */
		export function runTests(run: TestRunRequest, token?: CancellationToken): Thenable<void>;

		/**
		 * Returns an observer that watches and can request tests.
		 */
		export function createTestObserver(): TestObserver;
		/**
		 * List of test results stored by the editor, sorted in descending
		 * order by their `completedAt` time.
		 */
		export const testResults: ReadonlyArray<TestRunResult>;

		/**
		 * Event that fires when the {@link testResults} array is updated.
		 */
		export const onDidChangeTestResults: Event<void>;
	}

	export interface TestObserver {
		/**
		 * List of tests returned by test provider for files in the workspace.
		 */
		readonly tests: ReadonlyArray<TestItem>;

		/**
		 * An event that fires when an existing test in the collection changes, or
		 * null if a top-level test was added or removed. When fired, the consumer
		 * should check the test item and all its children for changes.
		 */
		readonly onDidChangeTest: Event<TestsChangeEvent>;

		/**
		 * Dispose of the observer, allowing the editor to eventually tell test
		 * providers that they no longer need to update tests.
		 */
		dispose(): void;
	}

	export interface TestsChangeEvent {
		/**
		 * List of all tests that are newly added.
		 */
		readonly added: ReadonlyArray<TestItem>;

		/**
		 * List of existing tests that have updated.
		 */
		readonly updated: ReadonlyArray<TestItem>;

		/**
		 * List of existing tests that have been removed.
		 */
		readonly removed: ReadonlyArray<TestItem>;
	}

	/**
	 * A test item is an item shown in the "test explorer" view. It encompasses
	 * both a suite and a test, since they have almost or identical capabilities.
	 */
	export interface TestItem {
		/**
		 * Marks the test as outdated. This can happen as a result of file changes,
		 * for example. In "auto run" mode, tests that are outdated will be
		 * automatically rerun after a short delay. Invoking this on a
		 * test with children will mark the entire subtree as outdated.
		 *
		 * Extensions should generally not override this method.
		 */
		// todo@api still unsure about this
		invalidateResults(): void;
	}

	/**
	 * TestResults can be provided to the editor in {@link tests.publishTestResult},
	 * or read from it in {@link tests.testResults}.
	 *
	 * The results contain a 'snapshot' of the tests at the point when the test
	 * run is complete. Therefore, information such as its {@link Range} may be
	 * out of date. If the test still exists in the workspace, consumers can use
	 * its `id` to correlate the result instance with the living test.
	 */
	export interface TestRunResult {
		/**
		 * Unix milliseconds timestamp at which the test run was completed.
		 */
		readonly completedAt: number;

		/**
		 * Optional raw output from the test run.
		 */
		readonly output?: string;

		/**
		 * List of test results. The items in this array are the items that
		 * were passed in the {@link tests.runTests} method.
		 */
		readonly results: ReadonlyArray<Readonly<TestResultSnapshot>>;
	}

	/**
	 * A {@link TestItem}-like interface with an associated result, which appear
	 * or can be provided in {@link TestResult} interfaces.
	 */
	export interface TestResultSnapshot {
		/**
		 * Unique identifier that matches that of the associated TestItem.
		 * This is used to correlate test results and tests in the document with
		 * those in the workspace (test explorer).
		 */
		readonly id: string;

		/**
		 * Parent of this item.
		 */
		readonly parent?: TestResultSnapshot;

		/**
		 * URI this TestItem is associated with. May be a file or file.
		 */
		readonly uri?: Uri;

		/**
		 * Display name describing the test case.
		 */
		readonly label: string;

		/**
		 * Optional description that appears next to the label.
		 */
		readonly description?: string;

		/**
		 * Location of the test item in its `uri`. This is only meaningful if the
		 * `uri` points to a file.
		 */
		readonly range?: Range;

		/**
		 * State of the test in each task. In the common case, a test will only
		 * be executed in a single task and the length of this array will be 1.
		 */
		readonly taskStates: ReadonlyArray<TestSnapshotTaskState>;

		/**
		 * Optional list of nested tests for this item.
		 */
		readonly children: Readonly<TestResultSnapshot>[];
	}

	export interface TestSnapshotTaskState {
		/**
		 * Current result of the test.
		 */
		readonly state: TestResultState;

		/**
		 * The number of milliseconds the test took to run. This is set once the
		 * `state` is `Passed`, `Failed`, or `Errored`.
		 */
		readonly duration?: number;

		/**
		 * Associated test run message. Can, for example, contain assertion
		 * failure information if the test fails.
		 */
		readonly messages: ReadonlyArray<TestMessage>;
	}

	/**
	 * Possible states of tests in a test run.
	 */
	export enum TestResultState {
		// Test will be run, but is not currently running.
		Queued = 1,
		// Test is currently running
		Running = 2,
		// Test run has passed
		Passed = 3,
		// Test run has failed (on an assertion)
		Failed = 4,
		// Test run has been skipped
		Skipped = 5,
		// Test run failed for some other reason (compilation error, timeout, etc)
		Errored = 6
	}

	//#endregion

	//#region https://github.com/microsoft/vscode/issues/123713 @connor4312
	export interface TestRun {
		/**
		 * Test coverage provider for this result. An extension can defer setting
		 * this until after a run is complete and coverage is available.
		 */
		coverageProvider?: TestCoverageProvider;
		// ...
	}

	/**
	 * Provides information about test coverage for a test result.
	 * Methods on the provider will not be called until the test run is complete
	 */
	export interface TestCoverageProvider<T extends FileCoverage = FileCoverage> {
		/**
		 * Returns coverage information for all files involved in the test run.
		 * @param token A cancellation token.
		 * @return Coverage metadata for all files involved in the test.
		 */
		provideFileCoverage(token: CancellationToken): ProviderResult<T[]>;

		/**
		 * Give a FileCoverage to fill in more data, namely {@link FileCoverage.detailedCoverage}.
		 * The editor will only resolve a FileCoverage once, and onyl if detailedCoverage
		 * is undefined.
		 *
		 * @param coverage A coverage object obtained from {@link provideFileCoverage}
		 * @param token A cancellation token.
		 * @return The resolved file coverage, or a thenable that resolves to one. It
		 * is OK to return the given `coverage`. When no result is returned, the
		 * given `coverage` will be used.
		 */
		resolveFileCoverage?(coverage: T, token: CancellationToken): ProviderResult<T>;
	}

	/**
	 * A class that contains information about a covered resource. A count can
	 * be give for lines, branches, and functions in a file.
	 */
	export class CoveredCount {
		/**
		 * Number of items covered in the file.
		 */
		covered: number;
		/**
		 * Total number of covered items in the file.
		 */
		total: number;

		/**
		 * @param covered Value for {@link CovereredCount.covered}
		 * @param total Value for {@link CovereredCount.total}
		 */
		constructor(covered: number, total: number);
	}

	/**
	 * Contains coverage metadata for a file.
	 */
	export class FileCoverage {
		/**
		 * File URI.
		 */
		readonly uri: Uri;

		/**
		 * Statement coverage information. If the reporter does not provide statement
		 * coverage information, this can instead be used to represent line coverage.
		 */
		statementCoverage: CoveredCount;

		/**
		 * Branch coverage information.
		 */
		branchCoverage?: CoveredCount;

		/**
		 * Function coverage information.
		 */
		functionCoverage?: CoveredCount;

		/**
		 * Detailed, per-statement coverage. If this is undefined, the editor will
		 * call {@link TestCoverageProvider.resolveFileCoverage} when necessary.
		 */
		detailedCoverage?: DetailedCoverage[];

		/**
		 * Creates a {@link FileCoverage} instance with counts filled in from
		 * the coverage details.
		 * @param uri Covered file URI
		 * @param detailed Detailed coverage information
		 */
		static fromDetails(uri: Uri, details: readonly DetailedCoverage[]): FileCoverage;

		/**
		 * @param uri Covered file URI
		 * @param statementCoverage Statement coverage information. If the reporter
		 * does not provide statement coverage information, this can instead be
		 * used to represent line coverage.
		 * @param branchCoverage Branch coverage information
		 * @param functionCoverage Function coverage information
		 */
		constructor(
			uri: Uri,
			statementCoverage: CoveredCount,
			branchCoverage?: CoveredCount,
			functionCoverage?: CoveredCount
		);
	}

	/**
	 * Contains coverage information for a single statement or line.
	 */
	export class StatementCoverage {
		/**
		 * The number of times this statement was executed. If zero, the
		 * statement will be marked as un-covered.
		 */
		executionCount: number;

		/**
		 * Statement location.
		 */
		location: Position | Range;

		/**
		 * Coverage from branches of this line or statement. If it's not a
		 * conditional, this will be empty.
		 */
		branches: BranchCoverage[];

		/**
		 * @param location The statement position.
		 * @param executionCount The number of times this statement was
		 * executed. If zero, the statement will be marked as un-covered.
		 * @param branches Coverage from branches of this line.  If it's not a
		 * conditional, this should be omitted.
		 */
		constructor(executionCount: number, location: Position | Range, branches?: BranchCoverage[]);
	}

	/**
	 * Contains coverage information for a branch of a {@link StatementCoverage}.
	 */
	export class BranchCoverage {
		/**
		 * The number of times this branch was executed. If zero, the
		 * branch will be marked as un-covered.
		 */
		executionCount: number;

		/**
		 * Branch location.
		 */
		location?: Position | Range;

		/**
		 * @param executionCount The number of times this branch was executed.
		 * @param location The branch position.
		 */
		constructor(executionCount: number, location?: Position | Range);
	}

	/**
	 * Contains coverage information for a function or method.
	 */
	export class FunctionCoverage {
		/**
		 * The number of times this function was executed. If zero, the
		 * function will be marked as un-covered.
		 */
		executionCount: number;

		/**
		 * Function location.
		 */
		location: Position | Range;

		/**
		 * @param executionCount The number of times this function was executed.
		 * @param location The function position.
		 */
		constructor(executionCount: number, location: Position | Range);
	}

	export type DetailedCoverage = StatementCoverage | FunctionCoverage;

	//#endregion
}
