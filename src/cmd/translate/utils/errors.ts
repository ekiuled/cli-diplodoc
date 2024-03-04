export class TranslateError extends Error {
    code: string;

    fatal: boolean;

    constructor(message: string, code: string, fatal = false) {
        super(message);

        this.code = code;
        this.fatal = fatal;
    }
}

export class RequestError extends TranslateError {
    static canRetry(error: any) {
        if (error instanceof RequestError) {
            switch (true) {
                case error.status === 429:
                    return true;
                case error.status === 500:
                    return true;
                case error.status === 503:
                    return true;
                case error.status === 504:
                    return true;
                default:
                    return false;
            }
        }

        return false;
    }

    status: number;

    constructor(
        status: number,
        statusText: string,
        info: {code?: number; message?: string; fatal?: boolean} = {},
    ) {
        super(`${statusText}\n${info.message || ''}`, 'REQUEST_ERROR', info.fatal);

        this.status = status;
    }
}

const INACTIVE_CLOUD = /^The cloud .*? is inactive/;
const WRONG_APIKEY = /^Unknown api key/;
const WRONG_TOKEN = /^The token is invalid/;

export class AuthError extends TranslateError {
    static is(message: string) {
        return Boolean(AuthError.reason(message));
    }

    static reason(message: string) {
        switch (true) {
            case INACTIVE_CLOUD.test(message):
                return 'INACTIVE_CLOUD';
            case WRONG_APIKEY.test(message):
                return 'WRONG_APIKEY';
            case WRONG_TOKEN.test(message):
                return 'WRONG_TOKEN';
            default:
                return null;
        }
    }

    constructor(message: string) {
        super(message, AuthError.reason(message) || 'AUTH_ERROR', true);
    }
}

const LIMIT_EXCEED_RX = /^limit on units was exceeded. (.*)$/;

export class LimitExceed extends TranslateError {
    static is(message: string) {
        return Boolean(LIMIT_EXCEED_RX.test(message));
    }

    constructor(message: string) {
        const [, desc] = LIMIT_EXCEED_RX.exec(message) || [];
        super(desc, 'TRANSLATE_LIMIT_EXCEED', true);
    }
}

export class ExtractError extends TranslateError {
    constructor(error: Error) {
        super('EXTRACT_ERROR', error?.message || String(error));
    }
}

export class ComposeError extends TranslateError {
    constructor(error: Error) {
        super('COMPOSE_ERROR', error?.message || String(error));
    }
}
