import type {DocInnerProps} from '@diplodoc/client';
import {basename, dirname, extname, join, resolve} from 'path';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'fs';
import log from '@diplodoc/transform/lib/log';
import {asyncify, mapLimit} from 'async';
import {bold} from 'chalk';
import {dump, load} from 'js-yaml';
import shell from 'shelljs';
import dedent from 'ts-dedent';

import {
    Lang,
    PAGE_PROCESS_CONCURRENCY,
    ResourceType,
    SINGLE_PAGE_DATA_FILENAME,
    SINGLE_PAGE_FILENAME,
} from '../constants';
import {
    LeadingPage,
    MetaDataOptions,
    PathData,
    Resources,
    SinglePageResult,
    YfmToc,
} from '../models';
import {resolveMd2HTML, resolveMd2Md} from '../resolvers';
import {ArgvService, LeadingService, PluginService, SearchService, TocService} from '../services';
import {generateStaticMarkup} from '~/pages/document';
import {generateStaticRedirect} from '~/pages/redirect';
import {
    getDepth,
    joinSinglePageResults,
    logger,
    transformToc,
    transformTocForSinglePage,
} from '../utils';
import {getVCSConnector} from '../vcs-connector';
import {VCSConnector} from '../vcs-connector/connector-models';

const singlePageResults: Record<string, SinglePageResult[]> = {};
const singlePagePaths: Record<string, Set<string>> = {};

// Processes files of documentation (like index.yaml, *.md)
export async function processPages(outputBundlePath: string): Promise<void> {
    const {
        input: inputFolderPath,
        output: outputFolderPath,
        outputFormat,
        singlePage,
        resolveConditions,
    } = ArgvService.getConfig();

    const vcsConnector = await getVCSConnector();

    PluginService.setPlugins();

    const navigationPaths = TocService.getNavigationPaths();

    await mapLimit(
        navigationPaths,
        PAGE_PROCESS_CONCURRENCY,
        asyncify(async (pathToFile: string) => {
            const pathData = getPathData(
                pathToFile,
                inputFolderPath,
                outputFolderPath,
                outputFormat,
                outputBundlePath,
            );

            logger.proc(pathToFile);

            const metaDataOptions = getMetaDataOptions(pathData, vcsConnector);

            await preparingPagesByOutputFormat(
                pathData,
                metaDataOptions,
                resolveConditions,
                singlePage,
            );
        }),
    );

    if (singlePage) {
        await saveSinglePages();

        if (outputFormat === 'html') {
            await saveTocData(transformTocForSinglePage, 'single-page-toc');
        }
    }

    if (outputFormat === 'html') {
        saveRedirectPage(outputFolderPath);
        await saveTocData(transformToc, 'toc');
    }
}

function getPathData(
    pathToFile: string,
    inputFolderPath: string,
    outputFolderPath: string,
    outputFormat: string,
    outputBundlePath: string,
): PathData {
    const pathToDir: string = dirname(pathToFile);
    const filename: string = basename(pathToFile);
    const fileExtension: string = extname(pathToFile);
    const fileBaseName: string = basename(filename, fileExtension);
    const outputDir = resolve(outputFolderPath, pathToDir);
    const outputFileName = `${fileBaseName}.${outputFormat}`;
    const outputPath = resolve(outputDir, outputFileName);
    const resolvedPathToFile = resolve(inputFolderPath, pathToFile);
    const outputTocDir = TocService.getTocDir(resolvedPathToFile);

    const pathData: PathData = {
        pathToFile,
        resolvedPathToFile,
        filename,
        fileBaseName,
        fileExtension,
        outputDir,
        outputPath,
        outputFormat,
        outputBundlePath,
        outputTocDir,
        inputFolderPath,
        outputFolderPath,
    };

    return pathData;
}

async function saveTocData(transform: (toc: YfmToc, tocDir: string) => YfmToc, filename: string) {
    const tocs = TocService.getAllTocs();
    const {output} = ArgvService.getConfig();

    for (const [path, toc] of tocs) {
        const outputPath = join(output, dirname(path), filename + '.js');
        mkdirSync(dirname(outputPath), {recursive: true});
        writeFileSync(
            outputPath,
            dedent`
                window.__DATA__.data.toc = ${JSON.stringify(transform(toc, dirname(path)))};
            `,
            'utf8',
        );
    }
}

async function saveSinglePages() {
    const {
        input: inputFolderPath,
        lang: configLang,
        langs: configLangs,
        resources,
    } = ArgvService.getConfig();

    try {
        await Promise.all(
            Object.keys(singlePageResults).map(async (tocDir) => {
                if (!singlePageResults[tocDir].length) {
                    return;
                }

                const relativeTocDir = tocDir
                    .replace(inputFolderPath, '')
                    .replace(/\\/g, '/')
                    .replace(/^\/?/, '');
                const singlePageBody = joinSinglePageResults(
                    singlePageResults[tocDir],
                    inputFolderPath,
                    relativeTocDir,
                );

                const toc = TocService.getForPath(join(relativeTocDir, 'toc.yaml'))[1] as YfmToc;
                const lang = configLang ?? Lang.RU;
                const langs = configLangs?.length ? configLangs : [lang];

                const pageData = {
                    data: {
                        leading: false as const,
                        html: singlePageBody,
                        headings: [],
                        meta: resources || {},
                        title: toc.title || '',
                    },
                    router: {
                        pathname: SINGLE_PAGE_FILENAME,
                        depth: getDepth(relativeTocDir) + 1,
                    },
                    lang,
                    langs,
                };

                // Save the full single page for viewing locally
                const singlePageFn = join(tocDir, SINGLE_PAGE_FILENAME);
                const singlePageDataFn = join(tocDir, SINGLE_PAGE_DATA_FILENAME);
                const singlePageContent = generateStaticMarkup(
                    pageData,
                    {path: join(relativeTocDir, 'single-page-toc'), content: toc},
                    (toc.title as string) || '',
                );

                writeFileSync(singlePageFn, singlePageContent);
                writeFileSync(singlePageDataFn, JSON.stringify(pageData));
            }),
        );
    } catch (error) {
        console.log(error);
    }
}

function saveRedirectPage(outputDir: string): void {
    const {lang, langs} = ArgvService.getConfig();

    const redirectLang = lang || langs?.[0] || Lang.RU;
    const redirectLangRelativePath = `./${redirectLang}/index.html`;

    const redirectPagePath = join(outputDir, 'index.html');
    const redirectLangPath = join(outputDir, redirectLangRelativePath);

    if (!existsSync(redirectPagePath) && existsSync(redirectLangPath)) {
        const content = generateStaticRedirect(redirectLang, redirectLangRelativePath);
        writeFileSync(redirectPagePath, content);
    }
}

function savePageResultForSinglePage(pageProps: DocInnerProps, pathData: PathData): void {
    const {pathToFile, outputTocDir} = pathData;

    // TODO: allow page-constructor pages?
    if (pageProps.data.leading) {
        return;
    }

    singlePagePaths[outputTocDir] = singlePagePaths[outputTocDir] || new Set();

    if (singlePagePaths[outputTocDir].has(pathToFile)) {
        return;
    }

    singlePagePaths[outputTocDir].add(pathToFile);

    singlePageResults[outputTocDir] = singlePageResults[outputTocDir] || [];
    singlePageResults[outputTocDir].push({
        path: pathToFile,
        content: pageProps.data.html,
        title: pageProps.data.title,
        // TODO: handle file resources
    });
}

function getMetaDataOptions(pathData: PathData, vcsConnector?: VCSConnector): MetaDataOptions {
    const {contributors, addSystemMeta, resources, allowCustomResources, vcs} =
        ArgvService.getConfig();

    const metaDataOptions: MetaDataOptions = {
        pathData,
        vcsConnector,
        isContributorsEnabled: Boolean(contributors && vcsConnector),
        addSystemMeta,
        shouldAlwaysAddVCSPath: typeof vcs?.remoteBase === 'string' && vcs.remoteBase.length > 0,
    };

    if (allowCustomResources && resources) {
        const allowedResources = Object.entries(resources).reduce((acc: Resources, [key, val]) => {
            if (Object.keys(ResourceType).includes(key)) {
                acc[key as keyof typeof ResourceType] = val;
            }
            return acc;
        }, {});

        metaDataOptions.resources = allowedResources;
    }

    return metaDataOptions;
}

async function preparingPagesByOutputFormat(
    path: PathData,
    metaDataOptions: MetaDataOptions,
    resolveConditions: boolean,
    singlePage: boolean,
): Promise<void> {
    const {
        filename,
        fileExtension,
        fileBaseName,
        outputDir,
        resolvedPathToFile,
        outputFormat,
        pathToFile,
    } = path;
    const {allowCustomResources} = ArgvService.getConfig();

    try {
        shell.mkdir('-p', outputDir);

        const isYamlFileExtension = fileExtension === '.yaml';

        if (resolveConditions && fileBaseName === 'index' && isYamlFileExtension) {
            LeadingService.filterFile(pathToFile);
        }

        if (outputFormat === 'md' && isYamlFileExtension && allowCustomResources) {
            processingYamlFile(path, metaDataOptions);
            return;
        }

        if (
            (outputFormat === 'md' && isYamlFileExtension) ||
            (outputFormat === 'html' && !isYamlFileExtension && fileExtension !== '.md')
        ) {
            copyFileWithoutChanges(resolvedPathToFile, outputDir, filename);
            return;
        }

        switch (outputFormat) {
            case 'md':
                await processingFileToMd(path, metaDataOptions);
                return;
            case 'html': {
                const resolvedFileProps = await processingFileToHtml(path, metaDataOptions);

                SearchService.add(pathToFile, resolvedFileProps);

                if (singlePage) {
                    savePageResultForSinglePage(resolvedFileProps, path);
                }

                return;
            }
        }
    } catch (e) {
        const message = `No such file or has no access to ${bold(resolvedPathToFile)}`;
        console.log(message, e);
        log.error(message);
    }
}
//@ts-ignore
function processingYamlFile(path: PathData, metaDataOptions: MetaDataOptions) {
    const {pathToFile, outputFolderPath, inputFolderPath} = path;

    const filePath = resolve(inputFolderPath, pathToFile);
    const content = readFileSync(filePath, 'utf8');
    const parsedContent = load(content) as LeadingPage;

    if (metaDataOptions.resources) {
        parsedContent.meta = {...parsedContent.meta, ...metaDataOptions.resources};
    }

    writeFileSync(resolve(outputFolderPath, pathToFile), dump(parsedContent));
}

function copyFileWithoutChanges(
    resolvedPathToFile: string,
    outputDir: string,
    filename: string,
): void {
    const from = resolvedPathToFile;
    const to = resolve(outputDir, filename);

    shell.cp(from, to);
}

async function processingFileToMd(path: PathData, metaDataOptions: MetaDataOptions): Promise<void> {
    const {outputPath, pathToFile} = path;

    await resolveMd2Md({
        inputPath: pathToFile,
        outputPath,
        metadata: metaDataOptions,
    });
}

async function processingFileToHtml(
    path: PathData,
    metaDataOptions: MetaDataOptions,
): Promise<DocInnerProps> {
    const {outputBundlePath, filename, fileExtension, outputPath, pathToFile} = path;

    return resolveMd2HTML({
        inputPath: pathToFile,
        outputBundlePath,
        fileExtension,
        outputPath,
        filename,
        metadata: metaDataOptions,
    });
}
