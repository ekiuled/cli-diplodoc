import type {Build} from '../..';
import type {Command} from '~/config';

import {resolve} from 'path';
import shell from 'shelljs';
import {LogLevels} from '@diplodoc/transform/lib/log';

import {configPath, resolveConfig, valuable} from '~/config';
import {LINT_CONFIG_FILENAME} from '~/constants';
import {options} from './config';

export type LintArgs = {
    lint: boolean;
};

export type LintRawConfig = {
    lint:
        | boolean
        | {
              enabled: boolean;
              config: string;
          };
};

export type LintConfig = {
    lint: {
        enabled: boolean;
        config: LogLevelConfig;
    };
};

type LogLevelConfig = {
    'log-levels': Record<string, LogLevels | `${LogLevels}`>;
};

// TODO(major): move to separated 'lint' command
export class Lint {
    apply(program: Build) {
        program.hooks.Command.tap('Lint', (command: Command) => {
            command.addOption(options.lint);
        });

        let resolvedPath: AbsolutePath | null = null;

        program.hooks.Config.tapPromise('Lint', async (config, args) => {
            let lint: LintConfig['lint'] | boolean = {
                enabled: true,
                config: {'log-levels': {}},
            };

            if (valuable(config.lint)) {
                lint = config.lint;
            }

            if (typeof lint === 'boolean') {
                lint = {
                    enabled: lint,
                    config: {'log-levels': {}},
                };
            }

            if (valuable(args.lint)) {
                lint.enabled = Boolean(args.lint);
            }

            config.lint = lint;

            if (config.lint.enabled) {
                const configFilename =
                    typeof config.lint.config === 'string'
                        ? config.resolve(config.lint.config as string)
                        : resolve(args.input, LINT_CONFIG_FILENAME);

                const lintConfig = await resolveConfig<Partial<LogLevelConfig>>(configFilename, {
                    fallback: {'log-levels': {}},
                });

                config.lint.config = lintConfig as LogLevelConfig;
                resolvedPath = lintConfig[configPath];
            }

            config.lint.config = config.lint.config || {'log-levels': {}};
            config.lint.config['log-levels'] = config.lint.config['log-levels'] || {};
            config.lint.config['log-levels']['MD033'] = config.allowHtml
                ? LogLevels.DISABLED
                : LogLevels.ERROR;

            return config;
        });

        program.hooks.AfterRun.for('md').tap('Lint', async (run) => {
            if (resolvedPath) {
                shell.cp(resolvedPath, run.output);
            }
        });
    }
}
