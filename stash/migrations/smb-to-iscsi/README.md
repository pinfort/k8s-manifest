# Migrate stash-data from SMB to iSCSI

One-off procedure for moving Stash's own data (config, SQLite database,
metadata, generated files, cache) from the SMB share `//192.168.2.210/stash`
to the iSCSI LUN on the NAS.

This directory is not part of `stash/kustomization.yaml`; `kubectl apply -k stash/`
does not touch it.

## Target

| Item          | Value                                                  |
| ------------- | ------------------------------------------------------ |
| Portal        | `192.168.2.210:3260`                                   |
| Target        | `nas02-stash-data`                                     |
| IQN           | `iqn.2004-04.com.qnap:ts-431kx:iscsi.target-0.5d7e7a`  |
| LUN           | `0` (`LUN_stash`, 100 GB, thick)                       |
| CHAP          | disabled                                               |
| Filesystem    | `ext4` (created by kubelet on first mount)             |

The media library (`stash-media-pv`) stays on SMB.

## Why a Job

The LUN is blank. It has no filesystem until the kubelet formats it the first
time a pod mounts it, so files cannot be copied onto it beforehand. `migrate.yaml`
runs a Job whose pod mounts the new PVC (which formats the LUN) together with the
old SMB share through a temporary PV/PVC, and copies everything with `cp -a`.

Do **not** run `kubectl apply -k stash/` before the copy finishes: the Deployment
has `replicas: 1` and Stash would initialize a fresh, empty config and database
on the LUN.

## Prerequisites

- `open-iscsi` installed and `iscsid` running on every node that may run the pod.
- If the QNAP iSCSI ACL restricts initiators, allow each node's initiator IQN
  (from `/etc/iscsi/initiatorname.iscsi`).
- The `stash-secrets` SealedSecret (SMB credentials) exists in the `stash`
  namespace. The temporary PV uses it.

## Procedure

Run from the repository root.

1. Stop Stash and remove the old SMB-backed PV/PVC. The data on the share is kept
   because the reclaim policy is `Retain`.

   ```sh
   kubectl scale deploy stash-deployment -n stash --replicas=0
   kubectl delete pvc stash-data-pvc -n stash
   kubectl delete pv stash-data-pv
   ```

2. Create only the new iSCSI PV/PVC, not the Deployment.

   ```sh
   kubectl apply -n stash -f stash/persistent-volume.yaml -f stash/persistent-volume-claim.yaml
   ```

   `stash-media-pv` / `stash-media-pvc` are reported as unchanged.

3. Run the copy Job and check the result. The sizes printed for old and new
   should match.

   ```sh
   kubectl apply -f stash/migrations/smb-to-iscsi/migrate.yaml
   kubectl wait -n stash --for=condition=complete job/stash-data-migrate --timeout=1h
   kubectl logs -n stash job/stash-data-migrate
   ```

4. Remove the temporary migration objects.

   ```sh
   kubectl delete -f stash/migrations/smb-to-iscsi/migrate.yaml
   ```

5. Start Stash on the LUN.

   ```sh
   kubectl apply -k stash/
   ```

## Notes

- Files come over with mode `0777` (from the old SMB mount options). Stash runs
  as root, so this is harmless.
- The new volume has `lost+found` at its root. Stash only uses the `config`,
  `metadata`, `generated` and `cache` subdirectories.
- The old share `//192.168.2.210/stash` is left untouched and can be deleted on
  the NAS once Stash is confirmed working.

## Troubleshooting

If the Job pod stays in `ContainerCreating`:

```sh
kubectl describe pod -n stash -l job-name=stash-data-migrate
```

This is almost always the iSCSI login: `open-iscsi` is missing on the node, or
the QNAP ACL is rejecting the node's initiator.

## Rollback

The old share is unchanged. To go back, delete the iSCSI PV/PVC, revert the
`stash-data-pv` / `stash-data-pvc` changes in git, and `kubectl apply -k stash/`.
