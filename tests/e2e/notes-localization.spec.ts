import {describe, test} from 'vitest';
import {TestAdapter, compareDirectories, getTestPaths} from '../fixtures';

describe('Notes block localization', () => {
    test('titles should be localized', async () => {
        const {inputPath, outputPath} = getTestPaths('mocks/notes-localization');
        await TestAdapter.testBuildPass(inputPath, outputPath + '-static-html', {
            md2md: false,
            md2html: true,
            args: '--static-content',
        });
        await compareDirectories(outputPath + '-static-html');
    });
});
