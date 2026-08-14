# Platformatic World on ECS

Running workflow applications on AWS ECS instead of Kubernetes.

Everything in the [main README](README.md) still applies: runs are pinned to the deployment version that started them, and the workflow service is still the thing that pins them. What changes is what the platform can tell the application about itself.

## What is different on ECS

One filesystem check answered three questions on Kubernetes -- whether there is an identity to authenticate with, whether the service is multi-tenant, and whether ICC provisions the application. ECS answers them differently, so they are separate:

| | Kubernetes | ECS |
|---|---|---|
| Authentication | service account token, verified by the workflow service | **none** |
| Tenancy | several applications per workflow service | same |
| Provisioning | ICC assigns the application ID and version, and registers handlers | same |

**There is no authentication on ECS in this release.** ECS has no service account token, so the workflow service accepts requests from anything that can reach it -- which is what the rest of the internal control plane already does, machinist included. Data remains logically scoped by application in SQL, preventing accidental mixing, but this is not access isolation: a caller that can reach the service and knows another application ID can name it in the URL.

Treat the workflow service as an internal service. Put it in a security group that only application tasks and ICC can reach.

## Prerequisites

- An ECS cluster running Fargate tasks, with ICC and machinist deployed against it (`PLT_PROVIDER=ecs`).
- **A Cloud Map private DNS namespace**, and machinist configured with its id. This is not optional for workflow applications: it is how ICC learns the address to send workflow runs to. Without it, applications deploy and register, and no run ever reaches them.
- The workflow service itself, reachable from application tasks, with `DATABASE_URL` pointing at its PostgreSQL database.

## Configuration

### machinist

```
PLT_PROVIDER=ecs
PLT_ECS_REGION=us-east-1
PLT_ECS_CLUSTER=my-cluster
PLT_ECS_SUBNETS=subnet-a,subnet-b
PLT_ECS_SECURITY_GROUPS=sg-app
PLT_ECS_EXECUTION_ROLE_ARN=arn:aws:iam::123456789012:role/exec
PLT_ECS_TASK_ROLE_ARN=arn:aws:iam::123456789012:role/task
PLT_ECS_CLOUD_MAP_NAMESPACE_ID=ns-abc123     # required for workflow apps
PLT_ECS_LOG_GROUP=/plt/apps                  # optional
PLT_ECS_LISTENER_ARN=arn:aws:...:listener/.. # only for skew protection
```

machinist's own IAM permissions are listed in its README. Cloud Map addressing
depends on `servicediscovery:ListServices`, `CreateService`, `GetNamespace`,
`GetService`, `DeleteService`, `ListInstances`, and `DeregisterInstance`. It
also requires `ecs:DescribeTaskDefinition`.

machinist uses `GetService` to resolve the actual Cloud Map service name from
the registry ARN. It uses `DescribeTaskDefinition` to discover the application
port when an A-record registry and a service without a load balancer do not
expose one directly.

### ICC

```
PLT_WORKFLOW_URL=http://workflow.plt.local:3042
```

**This URL is handed to every workflow application**, as `PLT_WORLD_SERVICE_URL`. On Kubernetes the address ICC uses and the address a pod uses are the same, so this never came up; on ECS it has to be resolvable *from application tasks*, not only from ICC. A Cloud Map name in the same VPC is the straightforward choice.

If it is set to something only ICC's own network can resolve, every workflow application will start and fail on a URL it cannot reach, and it will look like an application bug.

### The application

Nothing. ICC injects all three variables the World client needs:

| Variable | Value |
|---|---|
| `PLT_WORLD_SERVICE_URL` | from ICC's `PLT_WORKFLOW_URL` |
| `PLT_WORLD_APP_ID` | the application name ICC registered |
| `PLT_WORLD_DEPLOYMENT_VERSION` | the version ICC assigned |

Setting `PLT_WORLD_SERVICE_URL` yourself in the deploy environment overrides the injected one, which is the escape hatch for an external workflow service.

`K8S_ADMIN_SERVICE_ACCOUNT` has no meaning on ECS and can be left unset.

## What happens when you deploy

1. ICC builds a provider-neutral workload spec and sends it to machinist.
2. machinist registers a Fargate task definition and creates one ECS service per version, tagged with the application name, the version, and `plt.dev/workflow`. It registers the service in Cloud Map, and -- if skew protection is on -- creates the version's target group and attaches it in the same call.
3. The task starts. The World client sees `ECS_CONTAINER_METADATA_URI_V4`, which ECS injects into every container, and knows it is on a managed platform: it does not self-register its handlers, and it waits for the assigned version rather than stamping runs `local`.
4. The task registers with ICC, which registers the application with the workflow service and then its queue handlers at the Cloud Map address:

   ```
   http://<service>.<namespace>:3042/.well-known/workflow/v1/flow
                                    /.well-known/workflow/v1/step
                                    /.well-known/workflow/v1/webhook
   ```

   The handler identity is stable for the version:

   ```text
   <namespace>/<deploymentVersion>
   ```

   It does not identify an ECS task. A task replacement or a scale event leaves
   the handler unchanged, while Cloud Map sends each request to a currently
   healthy task belonging to that version's service.

   ICC marks this registration as `serviceScoped`. The workflow service then
   replaces obsolete machine-scoped rows for that version while leaving every
   other active or expiring version independently routable.

5. Runs dispatch to that address, pinned to the version that started them. Each
   active or expiring version retains its own handler and therefore executes
   using its own code. The workflow service removes that handler only when ICC
   explicitly expires the version.

## Checking it worked

```sh
# The version's Cloud Map service exists
aws servicediscovery list-services \
  --filters Name=NAMESPACE_ID,Values=$PLT_ECS_CLOUD_MAP_NAMESPACE_ID \
  --query 'Services[].Name'

# The ECS service carries the tags ICC identifies it by
aws ecs describe-services --cluster my-cluster --services my-app-v1 --include TAGS \
  --query 'services[0].tags'

# The workflow service has handlers for the version, at a resolvable address
psql "$DATABASE_URL" -c \
  "select deployment_version, workflow_url from workflow_queue_handlers
   order by last_heartbeat desc limit 5"
```

If the handler endpoints read `*.svc.cluster.local`, ICC did not receive an address from machinist -- check `PLT_ECS_CLOUD_MAP_NAMESPACE_ID`.

## Known limitations

**No authentication.** As above. The workflow service trusts its network on ECS.

**Version labels are normalised.** ECS service names take letters, numbers, underscores and hyphens; a semantic version produces `my-app-v1.2.3`, which ECS rejects. machinist rewrites it and appends a short digest of the original, so `my-app-v1.2.3` becomes `my-app-v1-2-3-4f878d`. The version label itself is unchanged -- it is what runs are pinned to, and what `?dpl=` carries.

**Skew protection is query-only.** An ALB cannot set a response cookie, so cookie pinning is unavailable on ECS. See the skew protection documentation for what that means for your applications.

**One ECS service per version.** Target groups per load balancer is 100 and cannot be raised, which caps a single load balancer at roughly 33 applications with three live versions each.

**Cleanup is configurable.** With `PLT_SKEW_AUTO_CLEANUP=true`, ICC asks
machinist to delete an expired version's ECS service and the resources created
with it, including its Cloud Map service, target group, and private-image pull
secret. With the setting disabled, ICC only scales the ECS service to zero. A
zero-task service has no Fargate compute charge, but retained resources still
consume ECS, Cloud Map, and especially target-group quotas. Changing the setting
affects future expirations; it does not retroactively delete versions that are
already expired.

## Validation status

The complete path has been exercised on a real Fargate cluster with query-based
skew protection: ICC deployed a workflow application, machinist created its
versioned ECS service and Cloud Map registration, ICC registered a
version-scoped handler, and a 12-step workflow completed through that handler.
This repository supplies the Workflow service and World client parts of that
path; the matching ICC and machinist ECS support must be deployed as well.

## Troubleshooting

**The application logs `no application ID configured; assuming "next" from package.json`.** `PLT_WORLD_APP_ID` did not reach the task. The application is claiming a tenant named after its package, which is very unlikely to be the one ICC registered. Check that the deploy went through ICC rather than being created directly in ECS.

**Runs stay queued and never execute.** No handler is registered at a reachable address. Check the Cloud Map namespace is configured, then that the workflow service's security group allows it to reach application tasks on the application port.

**The application never appears as a workflow application in ICC.** ICC identifies one by the `plt.dev/workflow` tag on the ECS service. A service created outside ICC will not have it; ECS also does not propagate tags to tasks unless the service asks it to, which machinist sets when it creates one.

**`PLT_WORLD_SERVICE_URL environment variable is required` at startup.** ICC injects it only for applications it knows are workflow applications. Same cause as above.
