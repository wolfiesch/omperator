export interface paths {
    "/v1": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Negotiate T4 API v1 and discover capabilities and bounds */
        get: operations["discoverV1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{sessionId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        get: operations["getSession"];
        put?: never;
        post?: never;
        delete: operations["deleteSession"];
        options?: never;
        head?: never;
        patch: operations["mutateSession"];
        trace?: never;
    };
    "/v1/sessions/{sessionId}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["cancelSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{sessionId}/commands": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["submitCommand"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{sessionId}/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Watch a bounded Server-Sent Events stream over HTTPS
         * @description The response is standard Server-Sent Events over HTTPS. Clients reconnect with the last event cursor in the cursor query parameter or Last-Event-ID header. Heartbeat events bound idle detection. Clients explicitly cancel by aborting the HTTPS request. A retained cursor expiry returns a typed 410 response with a snapshot resync target.
         */
        get: operations["watchSessionEvents"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{sessionId}/snapshot": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getSessionSnapshot"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/workspaces": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listWorkspaces"];
        put?: never;
        post: operations["createWorkspace"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/workspaces/{workspaceId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["parameters"]["WorkspaceId"];
            };
            cookie?: never;
        };
        get: operations["getWorkspace"];
        put?: never;
        post?: never;
        delete: operations["deleteWorkspace"];
        options?: never;
        head?: never;
        patch: operations["mutateWorkspace"];
        trace?: never;
    };
    "/v1/workspaces/{workspaceId}/sessions": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["parameters"]["WorkspaceId"];
            };
            cookie?: never;
        };
        get: operations["listSessions"];
        put?: never;
        post: operations["spawnSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        ApiError: {
            /** @enum {string} */
            code: "invalid_request" | "unauthenticated" | "forbidden" | "not_found" | "idempotency_key_required" | "idempotency_conflict" | "revision_conflict" | "incompatible_version" | "cursor_expired" | "unavailable" | "indeterminate" | "invalid_origin" | "https_required";
            message: string;
            requestId: string;
            resync?: components["schemas"]["Resync"];
            retryable: boolean;
            supportedMajors?: number[];
            violations?: components["schemas"]["FieldViolation"][];
        };
        BadRequestApiError: components["schemas"]["ApiError"] & {
            /** @enum {unknown} */
            code?: "invalid_request" | "idempotency_key_required" | "invalid_origin" | "https_required";
        };
        BadRequestErrorEnvelope: {
            error: components["schemas"]["BadRequestApiError"];
        };
        Capabilities: {
            [key: string]: components["schemas"]["CapabilityStatus"];
        };
        CapabilityDeprecation: {
            message: string;
            replacement?: string;
            sinceVersion?: string;
            /** Format: date-time */
            sunsetAt?: string;
        };
        CapabilityStatus: {
            authorized: boolean;
            available: boolean;
            deprecation?: components["schemas"]["CapabilityDeprecation"];
            enabled: boolean;
            supported: boolean;
        };
        CommandCreate: {
            command: string;
            /** @default {} */
            metadata?: {
                [key: string]: string | number | boolean | null;
            };
        };
        CommandResult: {
            commandId: components["schemas"]["ResourceId"];
            state: components["schemas"]["CommandState"];
        };
        /** @enum {string} */
        CommandState: "accepted" | "projected" | "dispatching" | "running" | "succeeded" | "failed" | "cancelling" | "cancelled" | "rejected" | "unavailable" | "indeterminate";
        CommandWatchEvent: {
            commandId: components["schemas"]["ResourceId"];
            cursor: components["schemas"]["Cursor"];
            state: components["schemas"]["CommandState"];
            /** @constant */
            type: "command";
        };
        ConflictApiError: components["schemas"]["ApiError"] & {
            /** @enum {unknown} */
            code?: "idempotency_conflict" | "revision_conflict";
        };
        ConflictErrorEnvelope: {
            error: components["schemas"]["ConflictApiError"];
        };
        /** @description Opaque server-issued header-safe SSE cursor. */
        Cursor: string;
        CursorExpiredApiError: components["schemas"]["ApiError"] & {
            /** @constant */
            code?: "cursor_expired";
            resync: components["schemas"]["Resync"];
        };
        CursorExpiredErrorEnvelope: {
            error: components["schemas"]["CursorExpiredApiError"];
        };
        Discovery: {
            apiVersion: string;
            capabilities: components["schemas"]["Capabilities"];
            limits: {
                commandBytesMax: number;
                commandMetadataValueBytesMax: number;
                commandRequestBytesMax: number;
                heartbeatSeconds: number;
                pageSizeDefault: number;
                pageSizeMax: number;
                watchEventsDefault: number;
                watchEventsMax: number;
            };
            serverBuild: components["schemas"]["ServerBuild"];
            supportedMajors: number[];
        };
        ErrorEnvelope: {
            error: components["schemas"]["ApiError"];
        };
        FieldViolation: {
            field: string;
            message: string;
            rule: string;
        };
        ForbiddenApiError: components["schemas"]["ApiError"] & {
            /** @constant */
            code?: "forbidden";
        };
        ForbiddenErrorEnvelope: {
            error: components["schemas"]["ForbiddenApiError"];
        };
        HeartbeatWatchEvent: {
            cursor: components["schemas"]["Cursor"];
            /** Format: date-time */
            observedAt: string;
            /** @constant */
            type: "heartbeat";
        };
        IncompatibleVersionApiError: components["schemas"]["ApiError"] & {
            /** @constant */
            code?: "incompatible_version";
            supportedMajors: number[];
        };
        IncompatibleVersionErrorEnvelope: {
            error: components["schemas"]["IncompatibleVersionApiError"];
        };
        InvalidRequestApiError: components["schemas"]["ApiError"] & {
            /** @constant */
            code?: "invalid_request";
            violations: components["schemas"]["FieldViolation"][];
        };
        InvalidRequestErrorEnvelope: {
            error: components["schemas"]["InvalidRequestApiError"];
        };
        Labels: {
            [key: string]: string;
        };
        NotFoundApiError: components["schemas"]["ApiError"] & {
            /** @constant */
            code?: "not_found";
        };
        NotFoundErrorEnvelope: {
            error: components["schemas"]["NotFoundApiError"];
        };
        ResourceId: string;
        Resync: {
            cursor: components["schemas"]["Cursor"];
            /** @description API-base-relative snapshot path for this watched session. */
            snapshotUrl: string;
        };
        Revision: number;
        ServerBuild: {
            revision: string;
            version: string;
        };
        Session: {
            id: components["schemas"]["ResourceId"];
            labels?: components["schemas"]["Labels"];
            revision: components["schemas"]["Revision"];
            state: components["schemas"]["SessionState"];
            title: string;
            workspaceId: components["schemas"]["ResourceId"];
        };
        SessionCreate: {
            labels?: components["schemas"]["Labels"];
            title: string;
        };
        SessionMutation: {
            labels?: components["schemas"]["Labels"];
            title?: string;
        };
        SessionPage: {
            items: components["schemas"]["Session"][];
            nextCursor?: components["schemas"]["Cursor"];
        };
        SessionSnapshot: {
            cursor: components["schemas"]["Cursor"];
            entries: components["schemas"]["SnapshotEntry"][];
            sessionId: components["schemas"]["ResourceId"];
            state: components["schemas"]["SessionState"];
        };
        /** @enum {string} */
        SessionState: "accepted" | "provisioning" | "ready" | "cancelling" | "cancelled" | "failed" | "unavailable" | "indeterminate";
        SessionWatchEvent: {
            cursor: components["schemas"]["Cursor"];
            revision: components["schemas"]["Revision"];
            state: components["schemas"]["SessionState"];
            /** @constant */
            type: "session";
        };
        SnapshotEntry: {
            /** @enum {string} */
            kind: "input" | "output" | "status";
            sequence: number;
            text: string;
        };
        UnauthenticatedApiError: components["schemas"]["ApiError"] & {
            /** @constant */
            code?: "unauthenticated";
        };
        UnauthenticatedErrorEnvelope: {
            error: components["schemas"]["UnauthenticatedApiError"];
        };
        UnavailableApiError: components["schemas"]["ApiError"] & {
            /** @enum {unknown} */
            code?: "unavailable" | "indeterminate";
        };
        UnavailableErrorEnvelope: {
            error: components["schemas"]["UnavailableApiError"];
        };
        WatchEvent: components["schemas"]["HeartbeatWatchEvent"] | components["schemas"]["SessionWatchEvent"] | components["schemas"]["CommandWatchEvent"];
        Workspace: {
            id: components["schemas"]["ResourceId"];
            labels?: components["schemas"]["Labels"];
            name: string;
            revision: components["schemas"]["Revision"];
            state: components["schemas"]["WorkspaceState"];
        };
        WorkspaceCreate: {
            labels?: components["schemas"]["Labels"];
            name: string;
        };
        WorkspaceMutation: {
            labels?: components["schemas"]["Labels"];
            name?: string;
        };
        WorkspacePage: {
            items: components["schemas"]["Workspace"][];
            nextCursor?: components["schemas"]["Cursor"];
        };
        /** @enum {string} */
        WorkspaceState: "accepted" | "provisioning" | "ready" | "deleting" | "deleted" | "failed" | "unavailable" | "indeterminate";
    };
    responses: {
        /** @description Command intent accepted with a stable outcome state */
        CommandAccepted: {
            headers: {
                "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                "T4-API-Version": components["headers"]["SelectedVersion"];
                "T4-Event-Cursor": components["headers"]["EventCursor"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["CommandResult"];
            };
        };
        /** @description Identical command request replay */
        CommandReplay: {
            headers: {
                "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                "T4-API-Version": components["headers"]["SelectedVersion"];
                "T4-Event-Cursor": components["headers"]["EventCursor"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["CommandResult"];
            };
        };
        /** @description Idempotent deletion accepted or resource already absent */
        Deleted: {
            headers: {
                "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                "T4-API-Version": components["headers"]["SelectedVersion"];
                "T4-Event-Cursor": components["headers"]["EventCursor"];
                [name: string]: unknown;
            };
            content?: never;
        };
        /** @description Negotiated v1 discovery */
        Discovery: {
            headers: {
                "T4-API-Version": components["headers"]["SelectedVersion"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Discovery"];
            };
        };
        /** @description Malformed request or missing idempotency key */
        Error400: {
            headers: {
                "T4-API-Version": components["headers"]["SelectedVersion"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["BadRequestErrorEnvelope"];
            };
        };
        /** @description Missing or invalid opaque bearer credential */
        Error401: {
            headers: {
                "WWW-Authenticate": "Bearer realm=\"t4\"";
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["UnauthenticatedErrorEnvelope"];
            };
        };
        /** @description Credential lacks the deny-by-default operation or resource scope */
        Error403: {
            headers: {
                "T4-API-Version": components["headers"]["SelectedVersion"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ForbiddenErrorEnvelope"];
            };
        };
        /** @description Resource absent or outside caller scope (scope existence is not disclosed) */
        Error404: {
            headers: {
                "T4-API-Version": components["headers"]["SelectedVersion"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["NotFoundErrorEnvelope"];
            };
        };
        /** @description Requested major is incompatible; no silent downgrade */
        Error406: {
            headers: {
                "T4-API-Version": components["headers"]["SelectedVersion"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["IncompatibleVersionErrorEnvelope"];
            };
        };
        /** @description Idempotency or resource revision conflict */
        Error409: {
            headers: {
                "T4-API-Version": components["headers"]["SelectedVersion"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ConflictErrorEnvelope"];
            };
        };
        /** @description Watch cursor expired; resync from the typed snapshot target */
        Error410: {
            headers: {
                "T4-API-Version": components["headers"]["SelectedVersion"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["CursorExpiredErrorEnvelope"];
            };
        };
        /** @description Bounded semantic validation failure with stable field violations */
        Error422: {
            headers: {
                "T4-API-Version": components["headers"]["SelectedVersion"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["InvalidRequestErrorEnvelope"];
            };
        };
        /** @description Service temporarily unavailable or outcome indeterminate. Retryable watch failures may advertise Retry-After; clients honor it with a 30 second ceiling. */
        Error503: {
            headers: {
                /** @description RFC 9110 delay in seconds or HTTP date; clients bound the applied delay. */
                "Retry-After"?: string;
                "T4-API-Version": components["headers"]["SelectedVersion"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["UnavailableErrorEnvelope"];
            };
        };
        /** @description Session */
        Session: {
            headers: {
                "T4-API-Version": components["headers"]["SelectedVersion"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Session"];
            };
        };
        /** @description Session intent accepted */
        SessionAccepted: {
            headers: {
                "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                "T4-API-Version": components["headers"]["SelectedVersion"];
                "T4-Event-Cursor": components["headers"]["EventCursor"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Session"];
            };
        };
        /** @description Bounded session page */
        SessionPage: {
            headers: {
                "T4-API-Version": components["headers"]["SelectedVersion"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["SessionPage"];
            };
        };
        /** @description Identical session mutation replay */
        SessionReplay: {
            headers: {
                "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                "T4-API-Version": components["headers"]["SelectedVersion"];
                "T4-Event-Cursor": components["headers"]["EventCursor"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Session"];
            };
        };
        /** @description Bounded session snapshot and reconnect cursor */
        Snapshot: {
            headers: {
                "T4-API-Version": components["headers"]["SelectedVersion"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["SessionSnapshot"];
            };
        };
        /** @description Workspace */
        Workspace: {
            headers: {
                "T4-API-Version": components["headers"]["SelectedVersion"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Workspace"];
            };
        };
        /** @description Workspace intent accepted */
        WorkspaceAccepted: {
            headers: {
                "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                "T4-API-Version": components["headers"]["SelectedVersion"];
                "T4-Event-Cursor": components["headers"]["EventCursor"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Workspace"];
            };
        };
        /** @description Bounded workspace page */
        WorkspacePage: {
            headers: {
                "T4-API-Version": components["headers"]["SelectedVersion"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["WorkspacePage"];
            };
        };
        /** @description Identical workspace request replay */
        WorkspaceReplay: {
            headers: {
                "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                "T4-API-Version": components["headers"]["SelectedVersion"];
                "T4-Event-Cursor": components["headers"]["EventCursor"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Workspace"];
            };
        };
    };
    parameters: {
        /** @description Requested API major. v1 clients send 1. Unsupported majors fail with 406 instead of silently downgrading. */
        ApiVersion: string;
        HeartbeatSeconds: number;
        /** @description Opaque caller-generated key scoped by the server to the authenticated principal, operation ID, and target resource IDs. Idempotency is evaluated only after path, query, header, and request-schema validation and application of schema defaults. Request identity is the operation ID, target IDs, relevant precondition headers, and the RFC 8785 JSON Canonicalization Scheme (JCS) bytes of the validated JSON body. JCS object member order is insignificant, array order is significant, omitted fields remain distinct unless the request schema defaulted them, and no Unicode normalization is performed beyond RFC 8785. Reusing a key with identical identity replays the original terminal response and advertises Idempotency-Replayed; reusing it with a different identity returns 409 idempotency_conflict. */
        IdempotencyKey: string;
        /** @description Decimal resource revision for optimistic mutation. */
        IfRevision: string;
        /** @description Standard SSE reconnect header. Must agree with cursor when both are present. */
        LastEventId: components["schemas"]["Cursor"];
        /** @description Omit to use the server-specific limits.watchEventsDefault value from discovery. */
        MaxEvents: number;
        /** @description Opaque page cursor, valid only for the same identity and list operation. */
        PageCursor: components["schemas"]["Cursor"];
        /** @description Omit to use the server-specific limits.pageSizeDefault value from discovery. */
        PageSize: number;
        SessionId: components["schemas"]["ResourceId"];
        /** @description Opaque last-consumed watch event cursor. */
        WatchCursor: components["schemas"]["Cursor"];
        WorkspaceId: components["schemas"]["ResourceId"];
    };
    requestBodies: never;
    headers: {
        /** @description Durable event cursor committed with the accepted mutation and preserved by replay. */
        EventCursor: components["schemas"]["Cursor"];
        /** @description True when this response replays a prior identical request. */
        IdempotencyReplayed: "true" | "false";
        /** @description Selected T4 API profile. This strict v1.0 contract requires exactly 1.0. */
        SelectedVersion: "1.0";
    };
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    discoverV1: {
        parameters: {
            query?: never;
            header: {
                /** @description Requested API major. v1 clients send 1. Unsupported majors fail with 406 instead of silently downgrading. */
                "T4-API-Version": components["parameters"]["ApiVersion"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Discovery"];
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            406: components["responses"]["Error406"];
            503: components["responses"]["Error503"];
        };
    };
    getSession: {
        parameters: {
            query?: never;
            header: {
                /** @description Requested API major. v1 clients send 1. Unsupported majors fail with 406 instead of silently downgrading. */
                "T4-API-Version": components["parameters"]["ApiVersion"];
            };
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Session"];
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            406: components["responses"]["Error406"];
            503: components["responses"]["Error503"];
        };
    };
    deleteSession: {
        parameters: {
            query?: never;
            header: {
                /** @description Opaque caller-generated key scoped by the server to the authenticated principal, operation ID, and target resource IDs. Idempotency is evaluated only after path, query, header, and request-schema validation and application of schema defaults. Request identity is the operation ID, target IDs, relevant precondition headers, and the RFC 8785 JSON Canonicalization Scheme (JCS) bytes of the validated JSON body. JCS object member order is insignificant, array order is significant, omitted fields remain distinct unless the request schema defaulted them, and no Unicode normalization is performed beyond RFC 8785. Reusing a key with identical identity replays the original terminal response and advertises Idempotency-Replayed; reusing it with a different identity returns 409 idempotency_conflict. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /** @description Requested API major. v1 clients send 1. Unsupported majors fail with 406 instead of silently downgrading. */
                "T4-API-Version": components["parameters"]["ApiVersion"];
            };
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            204: components["responses"]["Deleted"];
            400: components["responses"]["Error400"];
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            406: components["responses"]["Error406"];
            409: components["responses"]["Error409"];
            503: components["responses"]["Error503"];
        };
    };
    mutateSession: {
        parameters: {
            query?: never;
            header: {
                /** @description Opaque caller-generated key scoped by the server to the authenticated principal, operation ID, and target resource IDs. Idempotency is evaluated only after path, query, header, and request-schema validation and application of schema defaults. Request identity is the operation ID, target IDs, relevant precondition headers, and the RFC 8785 JSON Canonicalization Scheme (JCS) bytes of the validated JSON body. JCS object member order is insignificant, array order is significant, omitted fields remain distinct unless the request schema defaulted them, and no Unicode normalization is performed beyond RFC 8785. Reusing a key with identical identity replays the original terminal response and advertises Idempotency-Replayed; reusing it with a different identity returns 409 idempotency_conflict. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /** @description Requested API major. v1 clients send 1. Unsupported majors fail with 406 instead of silently downgrading. */
                "T4-API-Version": components["parameters"]["ApiVersion"];
                /** @description Decimal resource revision for optimistic mutation. */
                "T4-If-Revision": components["parameters"]["IfRevision"];
            };
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SessionMutation"];
            };
        };
        responses: {
            200: components["responses"]["SessionReplay"];
            400: components["responses"]["Error400"];
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            406: components["responses"]["Error406"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            503: components["responses"]["Error503"];
        };
    };
    cancelSession: {
        parameters: {
            query?: never;
            header: {
                /** @description Opaque caller-generated key scoped by the server to the authenticated principal, operation ID, and target resource IDs. Idempotency is evaluated only after path, query, header, and request-schema validation and application of schema defaults. Request identity is the operation ID, target IDs, relevant precondition headers, and the RFC 8785 JSON Canonicalization Scheme (JCS) bytes of the validated JSON body. JCS object member order is insignificant, array order is significant, omitted fields remain distinct unless the request schema defaulted them, and no Unicode normalization is performed beyond RFC 8785. Reusing a key with identical identity replays the original terminal response and advertises Idempotency-Replayed; reusing it with a different identity returns 409 idempotency_conflict. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /** @description Requested API major. v1 clients send 1. Unsupported majors fail with 406 instead of silently downgrading. */
                "T4-API-Version": components["parameters"]["ApiVersion"];
            };
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["SessionReplay"];
            202: components["responses"]["SessionAccepted"];
            400: components["responses"]["Error400"];
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            406: components["responses"]["Error406"];
            409: components["responses"]["Error409"];
            503: components["responses"]["Error503"];
        };
    };
    submitCommand: {
        parameters: {
            query?: never;
            header: {
                /** @description Opaque caller-generated key scoped by the server to the authenticated principal, operation ID, and target resource IDs. Idempotency is evaluated only after path, query, header, and request-schema validation and application of schema defaults. Request identity is the operation ID, target IDs, relevant precondition headers, and the RFC 8785 JSON Canonicalization Scheme (JCS) bytes of the validated JSON body. JCS object member order is insignificant, array order is significant, omitted fields remain distinct unless the request schema defaulted them, and no Unicode normalization is performed beyond RFC 8785. Reusing a key with identical identity replays the original terminal response and advertises Idempotency-Replayed; reusing it with a different identity returns 409 idempotency_conflict. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /** @description Requested API major. v1 clients send 1. Unsupported majors fail with 406 instead of silently downgrading. */
                "T4-API-Version": components["parameters"]["ApiVersion"];
            };
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CommandCreate"];
            };
        };
        responses: {
            200: components["responses"]["CommandReplay"];
            202: components["responses"]["CommandAccepted"];
            400: components["responses"]["Error400"];
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            406: components["responses"]["Error406"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            503: components["responses"]["Error503"];
        };
    };
    watchSessionEvents: {
        parameters: {
            query?: {
                /** @description Opaque last-consumed watch event cursor. */
                cursor?: components["parameters"]["WatchCursor"];
                heartbeatSeconds?: components["parameters"]["HeartbeatSeconds"];
                /** @description Omit to use the server-specific limits.watchEventsDefault value from discovery. */
                maxEvents?: components["parameters"]["MaxEvents"];
            };
            header: {
                /** @description Standard SSE reconnect header. Must agree with cursor when both are present. */
                "Last-Event-ID"?: components["parameters"]["LastEventId"];
                /** @description Requested API major. v1 clients send 1. Unsupported majors fail with 406 instead of silently downgrading. */
                "T4-API-Version": components["parameters"]["ApiVersion"];
            };
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Bounded SSE event stream. Every non-empty SSE data field is one JSON value conforming to WatchEvent; clients MUST reject unknown fields and schema-invalid event payloads before delivery. Transport chunk boundaries do not delimit frames. */
            200: {
                headers: {
                    "Cache-Control": "no-store";
                    "T4-API-Version": components["headers"]["SelectedVersion"];
                    [name: string]: unknown;
                };
                content: {
                    /** @example id: cur_01J...\nevent: heartbeat\ndata: {"type":"heartbeat","cursor":"cur_01J...","observedAt":"2026-07-21T00:00:00Z"}\n\n */
                    "text/event-stream": string;
                };
            };
            400: components["responses"]["Error400"];
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            406: components["responses"]["Error406"];
            410: components["responses"]["Error410"];
            422: components["responses"]["Error422"];
            503: components["responses"]["Error503"];
        };
    };
    getSessionSnapshot: {
        parameters: {
            query?: never;
            header: {
                /** @description Requested API major. v1 clients send 1. Unsupported majors fail with 406 instead of silently downgrading. */
                "T4-API-Version": components["parameters"]["ApiVersion"];
            };
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Snapshot"];
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            406: components["responses"]["Error406"];
            503: components["responses"]["Error503"];
        };
    };
    listWorkspaces: {
        parameters: {
            query?: {
                /** @description Opaque page cursor, valid only for the same identity and list operation. */
                cursor?: components["parameters"]["PageCursor"];
                /** @description Omit to use the server-specific limits.pageSizeDefault value from discovery. */
                pageSize?: components["parameters"]["PageSize"];
            };
            header: {
                /** @description Requested API major. v1 clients send 1. Unsupported majors fail with 406 instead of silently downgrading. */
                "T4-API-Version": components["parameters"]["ApiVersion"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["WorkspacePage"];
            400: components["responses"]["Error400"];
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            406: components["responses"]["Error406"];
            422: components["responses"]["Error422"];
            503: components["responses"]["Error503"];
        };
    };
    createWorkspace: {
        parameters: {
            query?: never;
            header: {
                /** @description Opaque caller-generated key scoped by the server to the authenticated principal, operation ID, and target resource IDs. Idempotency is evaluated only after path, query, header, and request-schema validation and application of schema defaults. Request identity is the operation ID, target IDs, relevant precondition headers, and the RFC 8785 JSON Canonicalization Scheme (JCS) bytes of the validated JSON body. JCS object member order is insignificant, array order is significant, omitted fields remain distinct unless the request schema defaulted them, and no Unicode normalization is performed beyond RFC 8785. Reusing a key with identical identity replays the original terminal response and advertises Idempotency-Replayed; reusing it with a different identity returns 409 idempotency_conflict. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /** @description Requested API major. v1 clients send 1. Unsupported majors fail with 406 instead of silently downgrading. */
                "T4-API-Version": components["parameters"]["ApiVersion"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WorkspaceCreate"];
            };
        };
        responses: {
            200: components["responses"]["WorkspaceReplay"];
            202: components["responses"]["WorkspaceAccepted"];
            400: components["responses"]["Error400"];
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            406: components["responses"]["Error406"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            503: components["responses"]["Error503"];
        };
    };
    getWorkspace: {
        parameters: {
            query?: never;
            header: {
                /** @description Requested API major. v1 clients send 1. Unsupported majors fail with 406 instead of silently downgrading. */
                "T4-API-Version": components["parameters"]["ApiVersion"];
            };
            path: {
                workspaceId: components["parameters"]["WorkspaceId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Workspace"];
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            406: components["responses"]["Error406"];
            503: components["responses"]["Error503"];
        };
    };
    deleteWorkspace: {
        parameters: {
            query?: never;
            header: {
                /** @description Opaque caller-generated key scoped by the server to the authenticated principal, operation ID, and target resource IDs. Idempotency is evaluated only after path, query, header, and request-schema validation and application of schema defaults. Request identity is the operation ID, target IDs, relevant precondition headers, and the RFC 8785 JSON Canonicalization Scheme (JCS) bytes of the validated JSON body. JCS object member order is insignificant, array order is significant, omitted fields remain distinct unless the request schema defaulted them, and no Unicode normalization is performed beyond RFC 8785. Reusing a key with identical identity replays the original terminal response and advertises Idempotency-Replayed; reusing it with a different identity returns 409 idempotency_conflict. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /** @description Requested API major. v1 clients send 1. Unsupported majors fail with 406 instead of silently downgrading. */
                "T4-API-Version": components["parameters"]["ApiVersion"];
            };
            path: {
                workspaceId: components["parameters"]["WorkspaceId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            204: components["responses"]["Deleted"];
            400: components["responses"]["Error400"];
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            406: components["responses"]["Error406"];
            409: components["responses"]["Error409"];
            503: components["responses"]["Error503"];
        };
    };
    mutateWorkspace: {
        parameters: {
            query?: never;
            header: {
                /** @description Opaque caller-generated key scoped by the server to the authenticated principal, operation ID, and target resource IDs. Idempotency is evaluated only after path, query, header, and request-schema validation and application of schema defaults. Request identity is the operation ID, target IDs, relevant precondition headers, and the RFC 8785 JSON Canonicalization Scheme (JCS) bytes of the validated JSON body. JCS object member order is insignificant, array order is significant, omitted fields remain distinct unless the request schema defaulted them, and no Unicode normalization is performed beyond RFC 8785. Reusing a key with identical identity replays the original terminal response and advertises Idempotency-Replayed; reusing it with a different identity returns 409 idempotency_conflict. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /** @description Requested API major. v1 clients send 1. Unsupported majors fail with 406 instead of silently downgrading. */
                "T4-API-Version": components["parameters"]["ApiVersion"];
                /** @description Decimal resource revision for optimistic mutation. */
                "T4-If-Revision": components["parameters"]["IfRevision"];
            };
            path: {
                workspaceId: components["parameters"]["WorkspaceId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WorkspaceMutation"];
            };
        };
        responses: {
            200: components["responses"]["WorkspaceReplay"];
            400: components["responses"]["Error400"];
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            406: components["responses"]["Error406"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            503: components["responses"]["Error503"];
        };
    };
    listSessions: {
        parameters: {
            query?: {
                /** @description Opaque page cursor, valid only for the same identity and list operation. */
                cursor?: components["parameters"]["PageCursor"];
                /** @description Omit to use the server-specific limits.pageSizeDefault value from discovery. */
                pageSize?: components["parameters"]["PageSize"];
            };
            header: {
                /** @description Requested API major. v1 clients send 1. Unsupported majors fail with 406 instead of silently downgrading. */
                "T4-API-Version": components["parameters"]["ApiVersion"];
            };
            path: {
                workspaceId: components["parameters"]["WorkspaceId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["SessionPage"];
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            406: components["responses"]["Error406"];
            422: components["responses"]["Error422"];
            503: components["responses"]["Error503"];
        };
    };
    spawnSession: {
        parameters: {
            query?: never;
            header: {
                /** @description Opaque caller-generated key scoped by the server to the authenticated principal, operation ID, and target resource IDs. Idempotency is evaluated only after path, query, header, and request-schema validation and application of schema defaults. Request identity is the operation ID, target IDs, relevant precondition headers, and the RFC 8785 JSON Canonicalization Scheme (JCS) bytes of the validated JSON body. JCS object member order is insignificant, array order is significant, omitted fields remain distinct unless the request schema defaulted them, and no Unicode normalization is performed beyond RFC 8785. Reusing a key with identical identity replays the original terminal response and advertises Idempotency-Replayed; reusing it with a different identity returns 409 idempotency_conflict. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /** @description Requested API major. v1 clients send 1. Unsupported majors fail with 406 instead of silently downgrading. */
                "T4-API-Version": components["parameters"]["ApiVersion"];
            };
            path: {
                workspaceId: components["parameters"]["WorkspaceId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SessionCreate"];
            };
        };
        responses: {
            200: components["responses"]["SessionReplay"];
            202: components["responses"]["SessionAccepted"];
            400: components["responses"]["Error400"];
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            406: components["responses"]["Error406"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            503: components["responses"]["Error503"];
        };
    };
}
