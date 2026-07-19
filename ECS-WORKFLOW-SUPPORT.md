# ECS Workflow Support

Status: the Workflow Service and World client changes described in sections 5.1 to 5.3 are implemented. The ICC and machinist work in section 5.4 is not, and nothing runs end to end on ECS until it is.

## 1. Problem Statement

The Workflow Service and the World client both need to run on ECS, where there is no Kubernetes service account token. Authentication is explicitly out of scope for the first iteration (see section 7), but per-application isolation is not: several apps must be able to share one Workflow Service on ECS without reading each other's runs.

Before this change an ECS deployment silently collapsed to a single tenant, and two further behaviours regressed in ways that were not obvious from the logs.

## 2. What Breaks on ECS Without This Change

Three independent questions are currently answered by one filesystem check:

1. **Authentication** - do I have a platform identity to present and verify?
2. **Tenancy** - is one Workflow Service serving several applications?
3. **Management** - is ICC provisioning me, assigning appId and version, and registering my handlers?

On Kubernetes all three answers are "yes", so `existsSync('/var/run/secrets/kubernetes.io/serviceaccount/token')` works as a proxy for all of them. On ECS the answers are no, yes, yes, and the proxy breaks.

### Server side

`packages/workflow/plugins/db.ts:23` uses that check to pick the operating mode. With no token present the service starts with `{ mode: 'none', defaultAppId }`, and `lib/auth/index.ts` then pins every request to that one application and sets `isAdmin = true`. Tenancy is gone, not just authentication.

### Client side

`packages/world/src/index.ts` calls `isRunningInK8s()` in three places, and only the first is really about Kubernetes:

| Site | Gate | Result on ECS today |
|---|---|---|
| `index.ts:93` | require an explicit appId | falls back to `readAppName()`, so an app whose package is named `next` claims tenant `next` |
| `index.ts:32` | skip self-registering handlers, ICC does it with reachable URLs | self-registers `http://localhost:$PORT`, unreachable from another task |
| `index.ts:~108` | `requireResolvedVersion` | enqueues as version `local` instead of waiting for the assigned one |

Only the first is a tenancy problem. The other two are deployment topology, and they break even though authentication is intentionally off. Handler registration is the most dangerous: a localhost URL means runs dispatch into a black hole rather than failing loudly.

## 3. Findings from the Current Code

These were verified against the codebase and shape the design.

**Tenancy already has exactly one chokepoint.** Handlers read `request.appId` in 29 places versus `params.appId` in 2 (both of those are the admin `k8s-binding` routes, which operate on app records rather than querying app data). Every data-plane query is already scoped `WHERE application_id = $n`. Whatever the auth hook puts in `request.appId` is the isolation boundary.

**The tenant is already named in the URL.** Every data-plane route is `/api/v1/apps/:appId/...`. Only `/api/v1/apps` and `/api/v1/versions/notify` are not, and both are registry/admin routes. The client hardcodes `/api/v1/apps/${appId}` as its base path, so the tenant is present on every request it makes.

**The multi-tenant resolution already exists.** The admin branch of `lib/auth/index.ts` already resolves an application from the URL when the caller has no binding. The unauthenticated path needs the same lookup, not a new mechanism.

**Authentication is not gated by what appears to gate it.** `AuthConfig.mode` is read in exactly one place, and the field that actually decides whether tokens are verified is `config.k8s` (`lib/auth/index.ts:46`). The enum and the behaviour have drifted apart.

**There is a latent bug in that existing branch.** When the app is not found, `request.appId` stays at the decorator default of `0`, so queries scope to `application_id = 0` and return empty results. A typo'd tenant looks like an empty tenant rather than an error.

**`db.ts:23` hardcodes the service account path** and ignores `PLT_WORLD_SA_PATH`, so the service cannot be driven into multi-tenant mode for testing.

**There is no authentication anywhere else in the internal control plane.** machinist has zero request hooks in its entire source, no auth plugin, and ICC's machinist client sends only `Content-Type` on all six call sites. machinist is a `ClusterIP` service on 4444. It is also the most privileged component in the system, since it creates and deletes workloads and applies image pull secrets. The trust boundary sits at ICC's external edge; everything behind it is unauthenticated and mutually trusting. World's K8s-token auth is the one exception.

## 4. Decisions

**Detect the platform, do not configure it.** ECS injects `ECS_CONTAINER_METADATA_URI_V4` into every container, exactly as the kubelet mounts the service account token. This keeps the "no configuration flag needed" property the design document already claims for mode selection.

**Separate identity from management.** `isRunningInK8s()` keeps one job, deciding whether an SA token is sent. A new `isManagedPlatform()` covers Kubernetes or ECS and drives appId, version, and handler registration.

**Resolve tenancy from the URL on managed platforms.** The client already sends the appId on every request, so nothing new needs conveying; the server only has to stop discarding it. Applications are registered by ICC and unknown ones are rejected. Unmanaged deployments keep today's single implicit tenant.

**No authentication on ECS in this iteration.** Consistent with the rest of the internal control plane (section 3). Revisited in section 7.

## 5. Design

### 5.1 Platform detection

Add to `packages/world/src/lib/k8s.ts` (or rename it to `platform.ts`):

```ts
export function isRunningInEcs (): boolean {
  return Boolean(process.env.ECS_CONTAINER_METADATA_URI_V4 || process.env.ECS_CONTAINER_METADATA_URI)
}

export function isManagedPlatform (): boolean {
  return isRunningInK8s() || isRunningInEcs()
}
```

`AWS_EXECUTION_ENV` is deliberately not used as the primary signal, because Lambda sets it too with a different prefix.

There is no override flag. `isManagedPlatform()` treats "on a managed platform" as "ICC is managing me", which is a proxy rather than a fact, and it can be wrong in one case: running the client in a pod or task with no ICC present. That deployment would skip handler registration and wait for a deployment version that never arrives. This is a known limitation rather than a regression, since `isRunningInK8s()` gates exactly those behaviours today and produces the same outcome. An override should be added when something actually needs it, designed against the real case, rather than shipped as a speculative knob.

### 5.2 Server side (`packages/workflow`)

The client already passes the application explicitly: `HttpClient` hardcodes `/api/v1/apps/${appId}` as its base path, so every request carries the tenant. Nothing new needs to be conveyed. The server simply has to stop discarding it.

There is no ECS-side alternative to this. `ECS_CONTAINER_METADATA_URI_V4` is a link-local endpoint scoped to the calling task, so it describes a container to itself and cannot tell a server anything about its caller. Unlike Kubernetes, where the caller presents a token the server verifies against an authority, nothing identifying arrives inbound on ECS. Mapping the source IP to a task via `DescribeTasks` was considered and rejected: it requires cluster-wide describe permissions, it breaks behind a load balancer, NAT, or bridge-mode networking, and it is authentication in disguise. If verified identity on ECS is wanted, SigV4 with the task role is the correct form of it (section 7).

**`AuthConfig.mode` goes away.** It is a four-value enum read in exactly one place (`lib/auth/index.ts:38`), and only `'none'` is distinguished there; `'k8s-token'`, `'api-key'`, and `'both'` all fall through to the same branch, where behaviour is actually decided by whether `config.k8s` is set. The enum is therefore one boolean's worth of information, and it is not even the field that does the work. Its unimplemented values are an active trap: `WF_AUTH_MODE=api-key` leaves `config.k8s` undefined, so the validator is null and every request is rejected as unauthenticated.

Replace it with the two axes this document has been separating throughout, and let authentication be enabled exactly when the configuration needed to perform it is supplied:

```ts
interface AuthConfig {
  k8s?: K8sConfig        // present: authenticate via TokenReview
  multiTenant: boolean   // resolve the tenant from the URL
  defaultAppId?: number  // used when multiTenant is false
}
```

That makes "authenticate but without the means to" unrepresentable, rather than a runtime surprise. `db.ts` computes both from platform detection: `k8s` when a service account token is present, `multiTenant` from `isManagedPlatform()`.

The hook then reads as three plain branches:

```ts
app.addHook('onRequest', async (request) => {
  const url = request.url.split('?')[0]
  if (PUBLIC_PATHS.has(url)) return

  if (validateK8s) { /* existing TokenReview path, unchanged */ return }

  request.isAdmin = true
  if (!config.multiTenant) {
    request.appId = config.defaultAppId || 0
    return
  }
  const match = url.match(/^\/api\/v1\/apps\/([^/]+)/)
  if (!match) {
    request.appId = config.defaultAppId || 0   // /api/v1/apps, /versions/notify
    return
  }
  const result = await app.pg.query('SELECT id FROM workflow_applications WHERE app_id = $1', [match[1]])
  if (result.rows.length === 0) throw new NotFound(`unknown application ${match[1]}`)
  request.appId = result.rows[0].id
})
```

Applications are registered by ICC, never auto-created. ICC already calls `POST /api/v1/apps` when it discovers a workflow pod on Kubernetes, and on ECS it is the component deploying the task and injecting `PLT_WORLD_APP_ID`, so it knows the identifier at deploy time and can register it the same way. Auto-creation was considered and dropped: it would silently mint a tenant from a typo, and since a wrong appId then reads as an empty application rather than an error, it would turn a misconfiguration into a debugging exercise.

Unmanaged deployments are untouched. With no Kubernetes token and no ECS metadata, the service keeps today's single-tenant behaviour, pinning `defaultAppId` from the startup upsert of `PLT_WORLD_APP_ID || 'default'`. That avoids the one case where URL resolution would regress local development, namely the client's `readAppName()` fallback disagreeing with the server's startup upsert, a mismatch currently hidden by the single-tenant collapse.

Fix the latent bug from section 3: an unresolved application in the authenticated admin branch should raise a not-found rather than leaving `appId` at `0`. The unauthenticated path above does this from the start.

Stop hardcoding the SA path at `db.ts:23`. Note that this check now selects tenancy as well as authentication, so it becomes `isManagedPlatform()` on the server too, with the token presence deciding only whether requests are authenticated.

### 5.3 Client side (`packages/world`)

Switch the three sites in section 2 from `isRunningInK8s()` to `isManagedPlatform()`. `#authHeaders()` in `lib/client.ts` keeps using `isRunningInK8s()`, since only Kubernetes supplies a token to send.

With no ECS metadata present, behaviour is bit for bit unchanged on Kubernetes and on a laptop.

### 5.4 ICC and machinist

Both repositories need work before anything runs end to end on ECS. The specifics below were read off the current code rather than estimated.

**ICC.** `registerWorkflowApp` (`services/control-plane/plugins/instances.js:45`) has four Kubernetes couplings, and the first makes the other three unreachable.

Lines 48-49 return early when there is no service account token. On ECS there is none, so the function does nothing at all: no application registered, no handlers registered. This has to become "authenticate when a token exists" rather than "abort when it does not".

Line 51 builds Authorization headers from that token. Unnecessary on ECS, where the service is unauthenticated.

Lines 71-79 POST a `k8s-binding` of `{namespace, serviceAccount: 'default'}`, which is meaningless without a service account, and return on any non-201 status, so a failure there also blocks handler registration. Skip it on ECS.

Line 86 builds the handler base URL as `http://${serviceName}.${namespace}.svc.cluster.local:${servicePort}`. ECS needs the equivalent from Cloud Map service discovery or an internal load balancer. This is the piece with genuine unknowns.

Beyond that, `PLT_WORLD_APP_ID` and `PLT_WORLD_DEPLOYMENT_VERSION` must be injected into ECS tasks as they already are for Kubernetes workflow apps.

**machinist.** The ECS provider (`services/main/plugins/providers/ecs.js`) implements reading and managing existing workloads: `getMachine`, `getMachines`, `setMachineLabels`, `getControllers`, `getController`, `updateControllerReplicas`, `deleteController`, `getServicesByLabels`, and `deleteService`. Three gaps remain, and only one of them is about skew protection.

`applyDeployment` and `applyService` are absent entirely. They create the workload, so the deploy path cannot run on ECS at all. This is the basic deploy path, unrelated to skew protection.

`listGateways`, `applyHTTPRoute`, `getHTTPRoute`, and `deleteHTTPRoute` exist as stubs that throw `MCHNST_NOT_IMPLEMENTED_BY_PROVIDER` (501), each labelled "Skew protection". Version-routed traffic therefore has no ECS implementation. That matters here because workflow apps deploy with `expirePolicy: 'workflow'` and depend on the version registry for draining, so workflow apps on ECS would have no version-safe drain even once registration works.

`applySecret` also throws 501. Kubernetes image-pull secrets have no ECS analogue: private images are pulled via a task-definition `repositoryCredentials` pointing at Secrets Manager, set when the task is registered rather than as a standalone resource.

### 5.5 Configuration Surface

"Detect the platform, do not configure it" applies to behaviour, not to identity. Three distinct categories survive, and it is worth being precise about which is which.

**Detected, never configured.** Whether to authenticate, whether to be multi-tenant, whether to self-register handlers, and whether to require a resolved deployment version. No mode flag and no platform switch is set by anyone, on any of the three environments.

**Injected by ICC, not set by a user.** On managed platforms the app receives `PLT_WORLD_SERVICE_URL`, `PLT_WORLD_APP_ID`, and `PLT_WORLD_DEPLOYMENT_VERSION`, and ICC registers the application. The identifier cannot be detected: that is exactly the `readAppName()` collision this plan removes. Detection establishes which platform a process is on, not which application it is.

**Operator configuration, set once per deployment.** `DATABASE_URL` for the service, plus `K8S_ADMIN_SERVICE_ACCOUNT` on Kubernetes. The latter has no default, and without it `adminServiceAccount` is undefined, so `isAdmin` never becomes true and ICC is not recognised as the control plane. It is not derivable, since the service cannot know which service account belongs to ICC.

Standalone remains the near-zero-config case it is today: point `PLT_WORLD_SERVICE_URL` at the service and every other value defaults.

## 6. Operating Modes, Revised

This supersedes the two-mode model in `PLATFORMATIC-WORLD-DESIGN.md` section 6.1. Authentication and tenancy become independent axes rather than one toggle:

| Environment | Authentication | Tenancy |
|---|---|---|
| Kubernetes with ICC | SA token via TokenReview | multi-tenant, binding-derived |
| ECS with ICC | none | multi-tenant, URL-derived, ICC-registered |
| Local development | none | single implicit tenant, unchanged |

Local development is explicitly left alone. Multi-tenancy is a property of managed platforms, where ICC is present to register applications; without it the service keeps the single implicit application it has today.

## 7. Security Posture

On ECS, anything that can reach the port can name any tenant and is treated as admin. Tenancy is an isolation boundary, not a security boundary, and security groups plus private subnets do the actual protecting.

This is a deliberate decision, recorded here rather than left implicit. It matches the existing posture of the internal control plane described in section 3, and is a strictly smaller concession than the unauthenticated machinist path that already exists.

Two caveats. Consistency with existing practice is not the same as being correct, and the machinist posture deserves its own review, particularly because a VPC security group is a coarser instrument than an in-cluster service with NetworkPolicy available. Separately, dropping authentication on ECS removes the tenancy enforcement that TokenReview provides on Kubernetes, which is why URL-derived tenancy must be real isolation in the queries rather than advisory. Section 3 confirms it already is.

The natural future direction is IAM. ECS tasks carry task roles, which are platform-issued, rotating, and verifiable, the same properties that make SA tokens the right choice on Kubernetes. Callers would sign with SigV4, the service would verify the caller identity, and bindings would key on role ARN instead of `namespace:serviceaccount`. That work should cover machinist and World together rather than World alone.

## 8. Sequencing

1. Server-side tenancy resolution. Done.
2. Client-side platform split and ECS detection. Done.
3. ICC and machinist. Not started. Largest and least certain, and in other repositories.

Steps 1 and 2 give correct isolation but leave handlers registered at localhost and versions stamped `local`, so ECS is not functional until step 3.

Note that steps 1 and 2 do not leave ECS neutral in the meantime. Unregistered applications are now rejected, and ICC does not register them on ECS (section 5.4), so an ECS deployment moves from silently collapsing into one tenant to returning not-found on every request. That is the intended direction, since failing closed beats silent cross-tenant reads, but it means step 3 is not optional follow-up: the two must land together before an ECS deployment is pointed at this.

## 9. Testing

Covered by `packages/workflow/test/ecs-multitenancy.test.ts`: two applications share one unauthenticated service and a cross-tenant read returns only the caller's data, a run is unreadable from another tenant, and an application that was never registered fails closed with a 404 rather than reading as an empty one.

Covered by `packages/world/test/platform.test.ts`: ECS detected from both metadata variables, Kubernetes both managed and authenticated, standalone neither, an explicit appId required on a managed platform, and no handler self-registration there.

Both suites simulate a platform purely through environment: `PLT_WORLD_SA_PATH` points service account discovery at a path that does or does not exist, and ECS is simulated by setting the metadata variable. No cluster or AWS account is needed.

One note for whoever extends these. The shared error handler in `plugins/events.ts` rebuilds every error response as `{statusCode, error, message}` and drops `code`, so assertions must match on status and message rather than on the `WF_*` code, even though `lib/errors.ts` defines one for every error type.

## 10. Open Questions

Confirm `ECS_CONTAINER_METADATA_URI_V4` is present on the launch type and platform version actually in use. This was taken from the AWS contract, not observed on a live task.

Decide how ICC addresses app tasks on ECS for handler registration. Cloud Map service discovery and an internal load balancer are the candidates; this is the largest unknown in section 5.4.

Decide whether skew protection is in scope for ECS. The four gateway and HTTPRoute methods throw 501 today, so version-routed traffic has no ECS implementation. Workflow apps deploy with `expirePolicy: 'workflow'` and depend on the version registry for draining, so without it they would run on ECS but with no version-safe drain. That is a larger question than the rest of section 5.4 and may warrant its own plan.
