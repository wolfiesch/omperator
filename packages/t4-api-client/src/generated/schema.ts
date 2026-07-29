export interface paths {
    "/.well-known/omperator": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getDiscovery"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/capabilities": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getCapabilities"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getEvents"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/runtimes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listRuntimes"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/runtimes/{runtimeId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                runtimeId: components["parameters"]["RuntimeId"];
            };
            cookie?: never;
        };
        get: operations["getRuntime"];
        put: operations["putRuntime"];
        post?: never;
        delete: operations["deleteRuntime"];
        options?: never;
        head?: never;
        patch: operations["patchRuntime"];
        trace?: never;
    };
    "/v1/runtimes/{runtimeId}:sleep": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                runtimeId: components["parameters"]["RuntimeId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["sleepRuntime"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/runtimes/{runtimeId}:wake": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                runtimeId: components["parameters"]["RuntimeId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["wakeRuntime"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/runtimes/{runtimeId}/connections": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                runtimeId: components["parameters"]["RuntimeId"];
            };
            cookie?: never;
        };
        get: operations["getRuntimeConnections"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/scopes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listScopes"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/version": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getVersion"];
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
        post?: never;
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
        put: operations["putWorkspace"];
        post?: never;
        delete: operations["deleteWorkspace"];
        options?: never;
        head?: never;
        patch: operations["patchWorkspace"];
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        BoundedCode: string;
        BoundedMessage: string;
        /** @enum {string} */
        BrowserPolicy: "Allowed" | "Disabled";
        BuildInfo: {
            builtAt: components["schemas"]["Timestamp"];
            revision: string;
            version: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * @example {
         *       "apiVersion": "v1",
         *       "protocols": {
         *         "machineProvider": {
         *           "versions": [
         *             1
         *           ],
         *           "capabilities": [
         *             "machine-lifecycle-v1"
         *           ]
         *         },
         *         "cmux": {
         *           "versions": [
         *             10
         *           ]
         *         },
         *         "ompApp": {
         *           "versions": [
         *             1
         *           ]
         *         }
         *       },
         *       "limits": {
         *         "maxActiveRuntimes": 20,
         *         "maxRetainedRuntimes": 100,
         *         "idempotencyRetentionSeconds": 86400,
         *         "eventRetentionSeconds": 3600,
         *         "maxPageSize": 200
         *       },
         *       "features": {
         *         "restLifecycle": true,
         *         "sshProvider": true,
         *         "directCmuxWebSocket": true,
         *         "browser": true,
         *         "scaleToZero": true
         *       }
         *     }
         */
        Capabilities: {
            /** @constant */
            apiVersion: "v1";
            features: components["schemas"]["CapabilityFeatures"];
            limits: components["schemas"]["CapabilityLimits"];
            protocols: components["schemas"]["CapabilitiesProtocols"];
        } & {
            [key: string]: unknown;
        };
        CapabilitiesProtocols: {
            cmux: components["schemas"]["NumericProtocolCapabilities"] & {
                versions?: unknown;
            };
            machineProvider: components["schemas"]["MachineProviderCapabilities"];
            ompApp: components["schemas"]["NumericProtocolCapabilities"] & {
                versions?: unknown;
            };
        } & {
            [key: string]: unknown;
        };
        CapabilityFeatures: {
            browser: boolean;
            directCmuxWebSocket: boolean;
            restLifecycle: boolean;
            scaleToZero: boolean;
            sshProvider: boolean;
        } & {
            [key: string]: unknown;
        };
        CapabilityLimits: {
            eventRetentionSeconds: number;
            idempotencyRetentionSeconds: number;
            maxActiveRuntimes: number;
            maxPageSize: number;
            maxRetainedRuntimes: number;
        } & {
            [key: string]: unknown;
        };
        CmuxWebSocketRoute: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "cmux-websocket";
            /** @constant */
            protocol: 10;
            url: components["schemas"]["CmuxWssUrl"];
        };
        /** Format: uri */
        CmuxWssUrl: string;
        Condition: {
            lastTransitionTime: components["schemas"]["Timestamp"];
            message?: components["schemas"]["BoundedMessage"];
            reason: components["schemas"]["BoundedCode"];
            status: components["schemas"]["ConditionStatus"];
            type: components["schemas"]["BoundedCode"];
        } & {
            [key: string]: unknown;
        };
        /** @enum {string} */
        ConditionStatus: "True" | "False" | "Unknown";
        /**
         * @example {
         *       "runtimeId": "rt_01JZ8R7N2P",
         *       "generation": "17",
         *       "expiresAt": "2026-07-28T12:05:00Z",
         *       "routes": [
         *         {
         *           "kind": "machine-provider-ssh",
         *           "host": "omp.example.net",
         *           "port": 22,
         *           "user": "tenant-user",
         *           "providerVersion": 1
         *         },
         *         {
         *           "kind": "omp-app-websocket",
         *           "url": "wss://omp.example.net/v1/ws",
         *           "protocol": "omp-app/1"
         *         },
         *         {
         *           "kind": "cmux-websocket",
         *           "url": "wss://omp.example.net/v1/cmux/rt_01JZ8R7N2P",
         *           "protocol": 10
         *         }
         *       ]
         *     }
         */
        ConnectionDescriptor: {
            expiresAt: components["schemas"]["Timestamp"];
            generation: components["schemas"]["Generation"];
            routes: components["schemas"]["ConnectionRoute"][];
            runtimeId: components["schemas"]["RuntimeId"];
        };
        ConnectionRoute: components["schemas"]["MachineProviderSshRoute"] | components["schemas"]["OmpAppWebSocketRoute"] | components["schemas"]["CmuxWebSocketRoute"];
        Cursor: string;
        /** @enum {string} */
        DesiredState: "Running" | "Sleeping" | "Stopped";
        /**
         * @example {
         *       "service": "omperator",
         *       "apiVersion": "v1",
         *       "restBaseUrl": "https://omp.example.net/v1",
         *       "ompAppWebSocketUrl": "wss://omp.example.net/v1/ws",
         *       "cmuxWebSocketTemplate": "wss://omp.example.net/v1/cmux/{runtimeId}",
         *       "ssh": {
         *         "host": "omp.example.net",
         *         "port": 22
         *       },
         *       "protocols": {
         *         "machineProvider": [
         *           "machine-provider-v1"
         *         ],
         *         "cmux": [
         *           10
         *         ],
         *         "application": [
         *           "omp-app/1"
         *         ]
         *       }
         *     }
         */
        Discovery: {
            /** @constant */
            apiVersion: "v1";
            cmuxWebSocketTemplate?: components["schemas"]["WssUrlTemplate"];
            ompAppWebSocketUrl?: components["schemas"]["WssUrl"];
            protocols: components["schemas"]["ProtocolDiscovery"];
            restBaseUrl: components["schemas"]["HttpsUrl"];
            /** @constant */
            service: "omperator";
            ssh?: components["schemas"]["SshEndpoint"];
        };
        DisplayName: string;
        EntityTag: string;
        EventId: string;
        Generation: string;
        HostProfileId: components["schemas"]["OpaqueId"];
        /** Format: uri */
        HttpsUrl: string;
        IdlePolicy: {
            /** @constant */
            enabled: false;
        } | {
            /** @constant */
            enabled: true;
            idleSeconds: number;
        };
        /**
         * @example {
         *       "eventId": "evt_01JZ8R9Q4T",
         *       "event": "invalidation",
         *       "resourceKind": "runtime",
         *       "resourceId": "rt_01JZ8R7N2P",
         *       "scopeId": "scope_personal",
         *       "revision": "opaque:0010",
         *       "phase": "Ready",
         *       "timestamp": "2026-07-28T12:00:01Z"
         *     }
         */
        InvalidationEvent: {
            /** @constant */
            event: "invalidation";
            eventId: components["schemas"]["EventId"];
            phase: components["schemas"]["Phase"];
            resourceId: components["schemas"]["OpaqueId"];
            resourceKind: components["schemas"]["ResourceKind"];
            revision: components["schemas"]["Revision"];
            scopeId: components["schemas"]["ScopeId"];
            timestamp: components["schemas"]["Timestamp"];
        };
        MachineProviderCapabilities: {
            capabilities: components["schemas"]["BoundedCode"][];
            versions: 1[];
        } & {
            [key: string]: unknown;
        };
        MachineProviderSshRoute: {
            host: components["schemas"]["PublicHost"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "machine-provider-ssh";
            port: number;
            /** @constant */
            providerVersion: 1;
            user: components["schemas"]["SshUser"];
        };
        NumericProtocolCapabilities: {
            versions: (1 | 10)[];
        } & {
            [key: string]: unknown;
        };
        OmpAppWebSocketRoute: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "omp-app-websocket";
            /** @constant */
            protocol: "omp-app/1";
            url: components["schemas"]["WssUrl"];
        };
        OpaqueId: string;
        PageCursor: {
            nextCursor?: components["schemas"]["Cursor"];
        } & {
            [key: string]: unknown;
        };
        /** @enum {string} */
        Phase: "Pending" | "Provisioning" | "Starting" | "Ready" | "Sleeping" | "Stopped" | "Deleting" | "Unavailable" | "Degraded" | "Failed";
        /**
         * @example {
         *       "type": "https://omperator.dev/problems/runtime-fencing",
         *       "title": "Runtime replacement is waiting for fencing",
         *       "status": 409,
         *       "detail": "The previous runtime generation is not yet proven stopped.",
         *       "instance": "urn:trace:01JZ8RB7Y9",
         *       "code": "runtime_fencing",
         *       "retryable": true,
         *       "retryAfterMs": 2000,
         *       "currentRevision": "opaque:0011"
         *     }
         */
        Problem: {
            code: string;
            currentRevision?: components["schemas"]["Revision"];
            detail: string;
            /** Format: uri-reference */
            instance: string;
            retryable: boolean;
            retryAfterMs?: number;
            status: number;
            title: string;
            /** Format: uri */
            type: string;
        } & {
            [key: string]: unknown;
        };
        ProtocolDiscovery: {
            application: "omp-app/1"[];
            cmux: 10[];
            machineProvider: "machine-provider-v1"[];
        };
        PublicHost: string;
        /**
         * @example {
         *       "eventId": "evt_01JZ8RA3W6",
         *       "event": "reset",
         *       "reason": "cursor_expired",
         *       "timestamp": "2026-07-28T12:05:00Z"
         *     }
         */
        ResetEvent: {
            /** @constant */
            event: "reset";
            eventId: components["schemas"]["EventId"];
            /** @constant */
            reason: "cursor_expired";
            timestamp: components["schemas"]["Timestamp"];
        };
        /** @enum {string} */
        ResourceKind: "scope" | "workspace" | "runtime";
        Revision: string;
        /**
         * @example {
         *       "id": "rt_01JZ8R7N2P",
         *       "scopeId": "scope_personal",
         *       "displayName": "api-refactor",
         *       "workspaceId": "ws_01JZ8R4M6K",
         *       "hostProfileId": "default",
         *       "desiredState": "Running",
         *       "phase": "Ready",
         *       "generation": "17",
         *       "revision": "opaque:0009",
         *       "capabilities": [
         *         "cmux",
         *         "omp-app",
         *         "browser-preview",
         *         "sleep"
         *       ],
         *       "conditions": [
         *         {
         *           "type": "RouteReady",
         *           "status": "True",
         *           "reason": "RuntimeReady",
         *           "lastTransitionTime": "2026-07-28T12:00:00Z"
         *         }
         *       ],
         *       "createdAt": "2026-07-28T11:59:55Z",
         *       "updatedAt": "2026-07-28T12:00:00Z"
         *     }
         */
        Runtime: {
            capabilities: components["schemas"]["BoundedCode"][];
            conditions: components["schemas"]["Condition"][];
            createdAt: components["schemas"]["Timestamp"];
            desiredState: components["schemas"]["DesiredState"];
            displayName: components["schemas"]["DisplayName"];
            generation: components["schemas"]["Generation"];
            hostProfileId: components["schemas"]["HostProfileId"];
            id: components["schemas"]["RuntimeId"];
            phase: components["schemas"]["Phase"];
            revision: components["schemas"]["Revision"];
            scopeId: components["schemas"]["ScopeId"];
            updatedAt: components["schemas"]["Timestamp"];
            workspaceId: components["schemas"]["WorkspaceId"];
        } & {
            [key: string]: unknown;
        };
        /**
         * @example {
         *       "scopeId": "scope_personal",
         *       "displayName": "api-refactor",
         *       "workspaceId": "ws_01JZ8R4M6K",
         *       "hostProfileId": "default",
         *       "desiredState": "Running",
         *       "browserPolicy": "Allowed"
         *     }
         */
        RuntimeCreate: {
            browserPolicy: components["schemas"]["BrowserPolicy"];
            desiredState: components["schemas"]["DesiredState"];
            displayName: components["schemas"]["DisplayName"];
            hostProfileId: components["schemas"]["HostProfileId"];
            idlePolicy?: components["schemas"]["IdlePolicy"];
            scopeId: components["schemas"]["ScopeId"];
            workspaceId: components["schemas"]["WorkspaceId"];
        };
        RuntimeId: components["schemas"]["OpaqueId"];
        RuntimePage: {
            items: components["schemas"]["Runtime"][];
            nextCursor?: components["schemas"]["Cursor"];
        } & {
            [key: string]: unknown;
        };
        /**
         * @example {
         *       "desiredState": "Sleeping"
         *     }
         */
        RuntimePatch: {
            browserPolicy?: components["schemas"]["BrowserPolicy"];
            desiredState?: components["schemas"]["DesiredState"];
            displayName?: components["schemas"]["DisplayName"];
            idlePolicy?: components["schemas"]["IdlePolicy"];
        };
        Scope: {
            displayName: components["schemas"]["DisplayName"];
            id: components["schemas"]["ScopeId"];
            /** @enum {string} */
            kind: "Personal" | "Team";
            revision: components["schemas"]["Revision"];
        } & {
            [key: string]: unknown;
        };
        ScopeId: components["schemas"]["OpaqueId"];
        ScopePage: {
            items: components["schemas"]["Scope"][];
            nextCursor?: components["schemas"]["Cursor"];
        } & {
            [key: string]: unknown;
        };
        SshEndpoint: {
            host: components["schemas"]["PublicHost"];
            port: number;
        };
        SshUser: string;
        /** Format: date-time */
        Timestamp: string;
        Version: {
            /** @constant */
            apiVersion: "v1";
            build: components["schemas"]["BuildInfo"];
            protocols: components["schemas"]["ProtocolDiscovery"];
        } & {
            [key: string]: unknown;
        };
        /**
         * @example {
         *       "id": "ws_01JZ8R4M6K",
         *       "scopeId": "scope_personal",
         *       "displayName": "api-refactor",
         *       "capacityBytes": 10737418240,
         *       "retention": "Retain",
         *       "phase": "Ready",
         *       "attachmentCount": 1,
         *       "revision": "opaque:0007",
         *       "conditions": [
         *         {
         *           "type": "StorageReady",
         *           "status": "True",
         *           "reason": "WorkspaceReady",
         *           "lastTransitionTime": "2026-07-28T11:59:50Z"
         *         }
         *       ],
         *       "createdAt": "2026-07-28T11:59:45Z",
         *       "updatedAt": "2026-07-28T11:59:50Z"
         *     }
         */
        Workspace: {
            attachmentCount: number;
            capacityBytes: number;
            conditions: components["schemas"]["Condition"][];
            createdAt: components["schemas"]["Timestamp"];
            displayName: components["schemas"]["DisplayName"];
            id: components["schemas"]["WorkspaceId"];
            phase: components["schemas"]["Phase"];
            retention: components["schemas"]["WorkspaceRetention"];
            revision: components["schemas"]["Revision"];
            scopeId: components["schemas"]["ScopeId"];
            updatedAt: components["schemas"]["Timestamp"];
        } & {
            [key: string]: unknown;
        };
        /**
         * @example {
         *       "scopeId": "scope_personal",
         *       "displayName": "api-refactor",
         *       "capacityBytes": 10737418240,
         *       "retention": "Retain"
         *     }
         */
        WorkspaceCreate: {
            capacityBytes: number;
            displayName: components["schemas"]["DisplayName"];
            retention: components["schemas"]["WorkspaceRetention"];
            scopeId: components["schemas"]["ScopeId"];
        };
        WorkspaceId: components["schemas"]["OpaqueId"];
        WorkspacePage: {
            items: components["schemas"]["Workspace"][];
            nextCursor?: components["schemas"]["Cursor"];
        } & {
            [key: string]: unknown;
        };
        /**
         * @example {
         *       "displayName": "api-refactor-main",
         *       "retention": "Retain"
         *     }
         */
        WorkspacePatch: {
            displayName?: components["schemas"]["DisplayName"];
            retention?: components["schemas"]["WorkspaceRetention"];
        };
        /** @enum {string} */
        WorkspaceRetention: "Retain" | "Delete";
        /** Format: uri */
        WssUrl: string;
        WssUrlTemplate: string;
    };
    responses: {
        /** @description Supported operations and limits */
        CapabilitiesResponse: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Capabilities"];
            };
        };
        /** @description Authorized current routes */
        ConnectionDescriptorResponse: {
            headers: {
                "Cache-Control": components["headers"]["CacheControl"];
                ETag: components["headers"]["ETag"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ConnectionDescriptor"];
            };
        };
        /** @description Deletion completed */
        DeletedResponse: {
            headers: {
                [name: string]: unknown;
            };
            content?: never;
        };
        /** @description Service discovery */
        DiscoveryResponse: {
            headers: {
                "Cache-Control": components["headers"]["CacheControl"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Discovery"];
            };
        };
        /** @description Lifecycle invalidations */
        EventStreamResponse: {
            headers: {
                "Cache-Control": components["headers"]["CacheControl"];
                [name: string]: unknown;
            };
            content: {
                "text/event-stream": string;
            };
        };
        /** @description Problem details */
        ProblemResponse: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Runtime change accepted */
        RuntimeAcceptedResponse: {
            headers: {
                ETag: components["headers"]["ETag"];
                Location: components["headers"]["Location"];
                "Retry-After": components["headers"]["RetryAfter"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Runtime"];
            };
        };
        /** @description Runtime created and ready */
        RuntimeCreatedResponse: {
            headers: {
                ETag: components["headers"]["ETag"];
                Location: components["headers"]["Location"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Runtime"];
            };
        };
        /** @description Runtime page */
        RuntimePageResponse: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["RuntimePage"];
            };
        };
        /** @description Runtime */
        RuntimeResponse: {
            headers: {
                ETag: components["headers"]["ETag"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Runtime"];
            };
        };
        /** @description Scope page */
        ScopePageResponse: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ScopePage"];
            };
        };
        /** @description Authentication required */
        UnauthorizedResponse: {
            headers: {
                "WWW-Authenticate": components["headers"]["WWWAuthenticate"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Version metadata */
        VersionResponse: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Version"];
            };
        };
        /** @description Workspace change accepted */
        WorkspaceAcceptedResponse: {
            headers: {
                ETag: components["headers"]["ETag"];
                Location: components["headers"]["Location"];
                "Retry-After": components["headers"]["RetryAfter"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Workspace"];
            };
        };
        /** @description Workspace created and ready */
        WorkspaceCreatedResponse: {
            headers: {
                ETag: components["headers"]["ETag"];
                Location: components["headers"]["Location"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Workspace"];
            };
        };
        /** @description Workspace page */
        WorkspacePageResponse: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["WorkspacePage"];
            };
        };
        /** @description Workspace */
        WorkspaceResponse: {
            headers: {
                ETag: components["headers"]["ETag"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Workspace"];
            };
        };
    };
    parameters: {
        Cursor: components["schemas"]["Cursor"];
        DesiredStateFilter: components["schemas"]["DesiredState"];
        IdempotencyKey: string;
        IfMatch: components["schemas"]["EntityTag"];
        IfNoneMatch: "*";
        LastEventId: components["schemas"]["EventId"];
        Limit: number;
        PhaseFilter: components["schemas"]["Phase"];
        RuntimeId: components["schemas"]["RuntimeId"];
        ScopeFilter: components["schemas"]["ScopeId"];
        UpdatedSinceFilter: components["schemas"]["Timestamp"];
        WorkspaceFilter: components["schemas"]["WorkspaceId"];
        WorkspaceId: components["schemas"]["WorkspaceId"];
    };
    requestBodies: {
        RuntimeCreate: {
            content: {
                /**
                 * @example {
                 *       "scopeId": "scope_personal",
                 *       "displayName": "api-refactor",
                 *       "workspaceId": "ws_01JZ8R4M6K",
                 *       "hostProfileId": "default",
                 *       "desiredState": "Running",
                 *       "browserPolicy": "Allowed"
                 *     }
                 */
                "application/json": components["schemas"]["RuntimeCreate"];
            };
        };
        RuntimePatch: {
            content: {
                /**
                 * @example {
                 *       "desiredState": "Sleeping"
                 *     }
                 */
                "application/merge-patch+json": components["schemas"]["RuntimePatch"];
            };
        };
        WorkspaceCreate: {
            content: {
                /**
                 * @example {
                 *       "scopeId": "scope_personal",
                 *       "displayName": "api-refactor",
                 *       "capacityBytes": 10737418240,
                 *       "retention": "Retain"
                 *     }
                 */
                "application/json": components["schemas"]["WorkspaceCreate"];
            };
        };
        WorkspacePatch: {
            content: {
                /**
                 * @example {
                 *       "displayName": "api-refactor-main",
                 *       "retention": "Retain"
                 *     }
                 */
                "application/merge-patch+json": components["schemas"]["WorkspacePatch"];
            };
        };
    };
    headers: {
        CacheControl: "no-store";
        ETag: components["schemas"]["EntityTag"];
        Location: string;
        RetryAfter: number;
        WWWAuthenticate: "Bearer";
    };
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    getDiscovery: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["DiscoveryResponse"];
            503: components["responses"]["ProblemResponse"];
        };
    };
    getCapabilities: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["CapabilitiesResponse"];
            401: components["responses"]["UnauthorizedResponse"];
            503: components["responses"]["ProblemResponse"];
        };
    };
    getEvents: {
        parameters: {
            query?: {
                scopeId?: components["parameters"]["ScopeFilter"];
            };
            header?: {
                "Last-Event-ID"?: components["parameters"]["LastEventId"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["EventStreamResponse"];
            400: components["responses"]["ProblemResponse"];
            401: components["responses"]["UnauthorizedResponse"];
            503: components["responses"]["ProblemResponse"];
        };
    };
    listRuntimes: {
        parameters: {
            query?: {
                cursor?: components["parameters"]["Cursor"];
                desiredState?: components["parameters"]["DesiredStateFilter"];
                limit?: components["parameters"]["Limit"];
                phase?: components["parameters"]["PhaseFilter"];
                scopeId?: components["parameters"]["ScopeFilter"];
                updatedSince?: components["parameters"]["UpdatedSinceFilter"];
                workspaceId?: components["parameters"]["WorkspaceFilter"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["RuntimePageResponse"];
            400: components["responses"]["ProblemResponse"];
            401: components["responses"]["UnauthorizedResponse"];
            503: components["responses"]["ProblemResponse"];
        };
    };
    getRuntime: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                runtimeId: components["parameters"]["RuntimeId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["RuntimeResponse"];
            401: components["responses"]["UnauthorizedResponse"];
            404: components["responses"]["ProblemResponse"];
            503: components["responses"]["ProblemResponse"];
        };
    };
    putRuntime: {
        parameters: {
            query?: never;
            header: {
                "If-None-Match": components["parameters"]["IfNoneMatch"];
            };
            path: {
                runtimeId: components["parameters"]["RuntimeId"];
            };
            cookie?: never;
        };
        requestBody: components["requestBodies"]["RuntimeCreate"];
        responses: {
            200: components["responses"]["RuntimeResponse"];
            201: components["responses"]["RuntimeCreatedResponse"];
            202: components["responses"]["RuntimeAcceptedResponse"];
            400: components["responses"]["ProblemResponse"];
            401: components["responses"]["UnauthorizedResponse"];
            403: components["responses"]["ProblemResponse"];
            409: components["responses"]["ProblemResponse"];
            412: components["responses"]["ProblemResponse"];
            422: components["responses"]["ProblemResponse"];
            503: components["responses"]["ProblemResponse"];
        };
    };
    deleteRuntime: {
        parameters: {
            query?: never;
            header: {
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                runtimeId: components["parameters"]["RuntimeId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            202: components["responses"]["RuntimeAcceptedResponse"];
            204: components["responses"]["DeletedResponse"];
            401: components["responses"]["UnauthorizedResponse"];
            403: components["responses"]["ProblemResponse"];
            404: components["responses"]["ProblemResponse"];
            409: components["responses"]["ProblemResponse"];
            412: components["responses"]["ProblemResponse"];
            503: components["responses"]["ProblemResponse"];
        };
    };
    patchRuntime: {
        parameters: {
            query?: never;
            header: {
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                runtimeId: components["parameters"]["RuntimeId"];
            };
            cookie?: never;
        };
        requestBody: components["requestBodies"]["RuntimePatch"];
        responses: {
            200: components["responses"]["RuntimeResponse"];
            202: components["responses"]["RuntimeAcceptedResponse"];
            400: components["responses"]["ProblemResponse"];
            401: components["responses"]["UnauthorizedResponse"];
            403: components["responses"]["ProblemResponse"];
            404: components["responses"]["ProblemResponse"];
            409: components["responses"]["ProblemResponse"];
            412: components["responses"]["ProblemResponse"];
            422: components["responses"]["ProblemResponse"];
            503: components["responses"]["ProblemResponse"];
        };
    };
    sleepRuntime: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                runtimeId: components["parameters"]["RuntimeId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["RuntimeResponse"];
            202: components["responses"]["RuntimeAcceptedResponse"];
            401: components["responses"]["UnauthorizedResponse"];
            403: components["responses"]["ProblemResponse"];
            404: components["responses"]["ProblemResponse"];
            409: components["responses"]["ProblemResponse"];
            412: components["responses"]["ProblemResponse"];
            503: components["responses"]["ProblemResponse"];
        };
    };
    wakeRuntime: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                runtimeId: components["parameters"]["RuntimeId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["RuntimeResponse"];
            202: components["responses"]["RuntimeAcceptedResponse"];
            401: components["responses"]["UnauthorizedResponse"];
            403: components["responses"]["ProblemResponse"];
            404: components["responses"]["ProblemResponse"];
            409: components["responses"]["ProblemResponse"];
            412: components["responses"]["ProblemResponse"];
            503: components["responses"]["ProblemResponse"];
        };
    };
    getRuntimeConnections: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                runtimeId: components["parameters"]["RuntimeId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["ConnectionDescriptorResponse"];
            401: components["responses"]["UnauthorizedResponse"];
            403: components["responses"]["ProblemResponse"];
            404: components["responses"]["ProblemResponse"];
            409: components["responses"]["ProblemResponse"];
            503: components["responses"]["ProblemResponse"];
        };
    };
    listScopes: {
        parameters: {
            query?: {
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["ScopePageResponse"];
            400: components["responses"]["ProblemResponse"];
            401: components["responses"]["UnauthorizedResponse"];
            503: components["responses"]["ProblemResponse"];
        };
    };
    getVersion: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["VersionResponse"];
            401: components["responses"]["UnauthorizedResponse"];
            503: components["responses"]["ProblemResponse"];
        };
    };
    listWorkspaces: {
        parameters: {
            query?: {
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
                phase?: components["parameters"]["PhaseFilter"];
                scopeId?: components["parameters"]["ScopeFilter"];
                updatedSince?: components["parameters"]["UpdatedSinceFilter"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["WorkspacePageResponse"];
            400: components["responses"]["ProblemResponse"];
            401: components["responses"]["UnauthorizedResponse"];
            503: components["responses"]["ProblemResponse"];
        };
    };
    getWorkspace: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["parameters"]["WorkspaceId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["WorkspaceResponse"];
            401: components["responses"]["UnauthorizedResponse"];
            404: components["responses"]["ProblemResponse"];
            503: components["responses"]["ProblemResponse"];
        };
    };
    putWorkspace: {
        parameters: {
            query?: never;
            header: {
                "If-None-Match": components["parameters"]["IfNoneMatch"];
            };
            path: {
                workspaceId: components["parameters"]["WorkspaceId"];
            };
            cookie?: never;
        };
        requestBody: components["requestBodies"]["WorkspaceCreate"];
        responses: {
            200: components["responses"]["WorkspaceResponse"];
            201: components["responses"]["WorkspaceCreatedResponse"];
            202: components["responses"]["WorkspaceAcceptedResponse"];
            400: components["responses"]["ProblemResponse"];
            401: components["responses"]["UnauthorizedResponse"];
            403: components["responses"]["ProblemResponse"];
            409: components["responses"]["ProblemResponse"];
            412: components["responses"]["ProblemResponse"];
            422: components["responses"]["ProblemResponse"];
            503: components["responses"]["ProblemResponse"];
        };
    };
    deleteWorkspace: {
        parameters: {
            query?: never;
            header: {
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                workspaceId: components["parameters"]["WorkspaceId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            202: components["responses"]["WorkspaceAcceptedResponse"];
            204: components["responses"]["DeletedResponse"];
            401: components["responses"]["UnauthorizedResponse"];
            403: components["responses"]["ProblemResponse"];
            404: components["responses"]["ProblemResponse"];
            409: components["responses"]["ProblemResponse"];
            412: components["responses"]["ProblemResponse"];
            503: components["responses"]["ProblemResponse"];
        };
    };
    patchWorkspace: {
        parameters: {
            query?: never;
            header: {
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                workspaceId: components["parameters"]["WorkspaceId"];
            };
            cookie?: never;
        };
        requestBody: components["requestBodies"]["WorkspacePatch"];
        responses: {
            200: components["responses"]["WorkspaceResponse"];
            202: components["responses"]["WorkspaceAcceptedResponse"];
            400: components["responses"]["ProblemResponse"];
            401: components["responses"]["UnauthorizedResponse"];
            403: components["responses"]["ProblemResponse"];
            404: components["responses"]["ProblemResponse"];
            409: components["responses"]["ProblemResponse"];
            412: components["responses"]["ProblemResponse"];
            422: components["responses"]["ProblemResponse"];
            503: components["responses"]["ProblemResponse"];
        };
    };
}
