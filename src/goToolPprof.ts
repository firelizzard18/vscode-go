import { exec } from 'child_process';
import { window, CancellationToken, TextDocumentContentProvider, Uri } from 'vscode';
import { getBinPath, getTempFilePath } from './util';

export class ProfileDocumentContentProvider implements TextDocumentContentProvider {
	provideTextDocumentContent(uri: Uri, token: CancellationToken): Promise<string | undefined> {
		return this.pprof(uri.path, token);
	}

	private pprof(file: string, token: CancellationToken) {
		const goBin = getBinPath('go');
		return new Promise<string | undefined>((resolve) => {
			const cp = exec(`${goBin} tool pprof -tree ${getTempFilePath(file)}`, async (err, stdout, stderr) => {
				if (err || stderr) {
					await window.showErrorMessage('Failed to execute `go tool pprof`');
					resolve(void 0);
				} else {
					resolve(stdout);
				}
			});

			token?.onCancellationRequested(() => cp.kill());
		});
	}
}
