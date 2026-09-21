// 类型化 IPC 封装：对 Rust 命令的薄包装 + 类型定义。
import { invoke } from "@tauri-apps/api/core";
import { i18n } from "./i18n";

export interface AppErrorShape {
  code: string;
  message: string;
}

// ---- 类型 ----
export interface VaultStatus {
  initialized: boolean;
  unlocked: boolean;
  workspacePath: string | null;
  workspaceId: string | null;
  autoLockMinutes: number;
  launchAtLogin: boolean;
  launchAtLoginSupported?: boolean;
  graceDays: number;
  graceActive: boolean;
  graceExpiresAt: string | null;
  closeAction: "tray" | "quit" | null;
  mobileBackgroundRun?: boolean;
  writesLocked?: boolean;
  startupNote?: string | null;
}

export interface AutoLockSettings {
  autoLockMinutes: number;
  lockOnSleep: boolean;
  /** 本平台能否判定锁屏。false 时只有休眠会触发锁定。 */
  screenLockDetectable: boolean;
}

export interface BiometricStatus {
  available: boolean;
  strong: boolean;
  kind: string;
  enabled: boolean;
  revealEnabled: boolean;
  revealSecret: boolean;
  stale: boolean;
  fingerprintAvailable?: boolean;
  faceAvailable?: boolean;
  preferredMethod?: string;
  enrolledMethod?: string;
}
export interface InitResult {
  recoveryKey: string;
  workspaceId: string;
}

export interface CameraPermissionStatus {
  granted: boolean;
  permanentlyDenied?: boolean;
}
export interface PathCheck {
  warning: string | null;
  error: string | null;
}
export interface KdfInfo {
  memMib: number;
  iters: number;
  parallelism: number;
  /** 内存是否已收在移动端安全上限内，即手机能否用访问密码解锁。 */
  mobileCompatible: boolean;
  mobileCeilingMib: number;
}
export interface KeyInfo {
  algorithm: string;
  fingerprint: string;
  publicOpenssh: string;
  bits: number | null;
  encrypted: boolean | null;
  comment: string;
}
export interface KeyRecord {
  id: string;
  name: string;
  algorithm: string;
  fingerprint: string;
  publicOpenssh: string;
  bits: number | null;
  hasPassphrase: boolean;
  weak: boolean;
  sourcePath: string | null;
  deployedPath: string | null;
  importedAt: string;
}
export interface RevealedKeyMaterial {
  publicOpenssh: string;
  privateOpenssh: string;
  passphrase: string | null;
}
export interface Identity {
  id: string;
  name: string;
  platform: string;
  hostAlias: string;
  realHost: string;
  user: string;
  email: string | null;
  gitUserName: string | null;
  keyId: string | null;
  owners: string[];
  strictMode: boolean;
}
export interface HostBlock {
  patterns: string[];
  options: [string, string][];
  startLine: number;
}
export interface Diagnostic {
  severity: "warn" | "error";
  code: string;
  message: string;
  host: string | null;
}
export interface ConfigView {
  path: string;
  workspacePath: string | null;
  systemPath: string;
  registered: boolean;
  raw: string;
  blocks: HostBlock[];
  diagnostics: Diagnostic[];
}
export interface ScannedKey {
  path: string;
  info: KeyInfo;
  inVault: boolean;
}
export interface SshBinary {
  path: string;
  version: string | null;
  source: string;
}
export interface Toolchain {
  system: SshBinary | null;
  git: SshBinary | null;
  gitUses: string | null;
}
export interface AgentKey {
  bits: number | null;
  fingerprint: string;
  comment: string;
  algo: string;
}
export interface AgentKeyResolved {
  agent: AgentKey;
  identityName: string | null;
  keyName: string | null;
}
export interface EnvCheck {
  key: string;
  label: string;
  ok: boolean;
  current: string | null;
  expected: string | null;
  hint?: string | null;
}
export interface AgentUnifyStatus {
  os: string;
  gitInstalled: boolean;
  agentRunning: boolean;
  gitSsh: string | null;
  sshAdd: string | null;
  authSock: string | null;
  agentPid: string | null;
  gitConfigOk: boolean;
  userGitSshOk: boolean;
  userSockOk: boolean;
  powershellProfileOk: boolean;
  bashProfileOk: boolean;
  aligned: boolean;
  gitConfigValue: string | null;
  userGitSsh: string | null;
  userAuthSock: string | null;
  checks: EnvCheck[];
}
export interface AgentUnifyReport {
  gitSsh: string;
  sshAdd: string;
  authSock: string;
  agentPid: string | null;
  gitConfig: boolean;
  userEnv: boolean;
  powershellProfile: boolean;
  bashProfile: boolean;
  steps: string[];
  hint: string;
}
export interface AgentStatus {
  running: boolean;
  usingFallback: boolean;
  ssh: string | null;
  sshAdd: string | null;
  authSock: string | null;
  keys: AgentKeyResolved[];
  unify: AgentUnifyStatus;
}
export type GitProvider = "github" | "gitlab" | "gitee";

export type ProbeKind =
  | "sshOk"
  | "publicOwner"
  | "publicNoClaim"
  | "repoMissing"
  | "keyMissing"
  | "noAccess"
  | "networkSsh";

export interface Candidate {
  identityId: string;
  identityName: string;
  hostAlias: string;
  confidence: "certain" | "veryHigh" | "mediumHigh" | "low";
  basis: string;
  probeKind?: ProbeKind;
}
export interface Inference {
  rewrittenUrl: string | null;
  recommended: Candidate | null;
  candidates: Candidate[];
  needsProbe: boolean;
}
export interface RepoInfo {
  path: string;
  remoteUrl: string | null;
  currentAlias: string | null;
  gitUserName: string | null;
  gitUserEmail: string | null;
  inferredIdentity: string | null;
  needsAliasFix: boolean;
  fixCommand: string | null;
}
export interface ConfigPreview {
  diff: string;
  newText: string;
}
export interface ManagedEntry {
  alias: string;
  hostName: string;
  user: string;
  identityFile: string;
  identitiesOnly: boolean;
}
export interface AuthResult {
  ok: boolean;
  account: string | null;
  message: string;
  errorCode: string | null;
}
export interface CreateIdentityArgs {
  name: string;
  platform: string;
  hostAlias: string;
  realHost: string;
  user?: string;
  email?: string;
  gitUserName?: string;
  strictMode: boolean;
  keyId?: string;
  keyComment?: string;
  owners?: string[];
}
export interface UpdateIdentityArgs {
  id: string;
  name: string;
  platform: string;
  hostAlias: string;
  realHost: string;
  user?: string;
  email?: string;
  gitUserName?: string;
  strictMode: boolean;
  owners?: string[];
}
export interface CreateIdentityResult {
  identity: Identity;
  publicOpenssh: string;
  configBackup: string | null;
  configVerified: boolean;
  identityFile: string;
}
export interface ClonePlan {
  kind: "empty" | "missing" | "parent" | "existingProject" | "alreadyGit" | "alreadyGitHasRemote" | "blocked" | string;
  suggestedMode: "clone" | "init" | "addRemote" | "blocked" | string;
  dest: string;
  targetPath: string;
  repoName: string;
  message: string;
  canProceed: boolean;
}
export interface CloneResult {
  dest: string;
  usedUrl: string;
  identityName: string;
  mode: string;
}
export interface CloneOrInitArgs {
  url: string;
  destDir: string;
  identityId: string;
  mode: string;
}
export interface ManagedRepoView {
  id: string;
  path: string;
  name: string;
  remoteUrl: string | null;
  identityId: string | null;
  identityName: string | null;
  addedAt: string;
  source: string;
  exists: boolean;
  currentAlias: string | null;
  needsAliasFix: boolean;
}
export interface ImportScanResult {
  imported: number;
  updated: number;
  skippedNoRemote: number;
  repos: ManagedRepoView[];
}

export interface BackupSummary {
  workspaceId: string;
  createdAt: string;
  identityCount: number;
  keyCount: number;
  repoCount: number;
  hasGithubPat: boolean;
}

export interface S3Config {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
}

export interface CloudSyncStatus {
  remoteExists: boolean;
  remoteUpdatedAt?: string;
  remoteWorkspaceId?: string;
  localIdentityCount: number;
  localKeyCount: number;
  localRepoCount: number;
  status: "synced" | "local_ahead" | "remote_ahead" | "not_synced" | "different_workspace" | "unconfigured" | "checking";
  headerReady?: boolean;
}

export interface SyncResult {
  syncedAt: string;
  objectsTransferred: number;
  identityCount: number;
  keyCount: number;
  repoCount: number;
  message: string;
}

export interface AutoSyncSettings {
  minutes: number;
  lastAutoSyncAt?: string | null;
  lastAutoSyncMessage?: string | null;
  defaultMinutes: number;
  syncAttachmentsWifiOnly: boolean;
  syncAttachmentsManualOnly: boolean;
}

export interface BlobSyncProgress {
  phase: "upload" | "download" | string;
  current: number;
  total: number;
}

export interface CloudSnapshot {
  id: string;
  createdAt: string;
  clientName: string;
  identityCount: number;
  keyCount: number;
  repoCount: number;
  isRecent?: boolean;
  isDailyFirst?: boolean;
}

export interface CloudSyncPageData {
  config: S3Config | null;
  autoSync: AutoSyncSettings;
  status: CloudSyncStatus;
  snapshots: CloudSnapshot[];
  remoteFresh: boolean;
}

export interface CloudRestorePreview {
  workspaceId: string;
  updatedAt?: string | null;
  identityCount: number;
  keyCount: number;
  repoCount: number;
  hasManifest: boolean;
}

export interface UpdateSource {
  kind: "github" | "manifest";
  repo?: string;
  manifestUrl?: string;
  includePrerelease: boolean;
}

export interface UpdateCheckResult {
  available: boolean;
  currentVersion: string;
  latestVersion: string | null;
  notes: string | null;
  pubDate: string | null;
  source: UpdateSource;
  downloadUrl: string | null;
  platform: string;
  selfUpdateSupported: boolean;
  sideloadUpdateSupported: boolean;
  storeUpdateSupported: boolean;
}

export interface UpdateProgress {
  phase: "started" | "downloading" | "finished";
  downloaded: number;
  total: number | null;
}

export interface NetworkProxy {
  enabled: boolean;
  scheme: "http" | "https" | "socks5" | string;
  host: string;
  port: number;
  username?: string | null;
  password?: string | null;
  applyToGitHttps: boolean;
  applyToSsh: boolean;
  applyToCloudSync: boolean;
}

export interface ProxyTestResult {
  httpsOk: boolean;
  httpsMs: number | null;
  httpsError: string | null;
  sshHelperFound: boolean;
  sshHelperName: string | null;
  sshNote: string | null;
}

// ---- 命令 ----
export const api = {
  // vault
  vaultStatus: () => invoke<VaultStatus>("vault_status"),
  checkWorkspacePath: (path: string) => invoke<PathCheck>("check_workspace_path", { path }),
  defaultWorkspacePath: () => invoke<string>("default_workspace_path"),
  vaultInit: (path: string, password: string) => invoke<InitResult>("vault_init", { path, password }),
  vaultUnlock: (password: string) => invoke<void>("vault_unlock", { password }),
  vaultUnlockRecovery: (recoveryKey: string) => invoke<void>("vault_unlock_recovery", { recoveryKey }),
  vaultUnlockBiometric: () => invoke<void>("vault_unlock_biometric"),
  biometricStatus: () => invoke<BiometricStatus>("biometric_status"),
  biometricEnable: (password: string) => invoke<void>("biometric_enable", { password }),
  biometricDisable: () => invoke<void>("biometric_disable"),
  revealAuthorizeBiometric: () => invoke<void>("reveal_authorize_biometric"),
  setBiometricRevealEnabled: (enabled: boolean) => invoke<void>("set_biometric_reveal_enabled", { enabled }),
  setBiometricRevealSecret: (enabled: boolean) => invoke<void>("set_biometric_reveal_secret", { enabled }),
  setBiometricMethod: (method: string) => invoke<string>("set_biometric_method", { method }),
  vaultLock: () => invoke<void>("vault_lock"),
  changePassword: (oldPassword: string, newPassword: string) =>
    invoke<void>("change_password", { oldPassword, newPassword }),
  rotateRecoveryKey: () => invoke<InitResult>("rotate_recovery_key"),
  getKdfInfo: () => invoke<KdfInfo>("get_kdf_info"),
  relaxKdfForMobile: (password: string) => invoke<KdfInfo>("relax_kdf_for_mobile", { password }),
  vaultTryGraceUnlock: () => invoke<boolean>("vault_try_grace_unlock"),
  setLaunchAtLogin: (enabled: boolean) => invoke<void>("set_launch_at_login", { enabled }),
  setGraceDays: (days: number) => invoke<void>("set_grace_days", { days }),
  reportActivity: () => invoke<void>("report_activity"),
  getAutoLockSettings: () => invoke<AutoLockSettings>("get_auto_lock_settings"),
  setAutoLockMinutes: (minutes: number) => invoke<number>("set_auto_lock_minutes", { minutes }),
  setLockOnSleep: (enabled: boolean) => invoke<void>("set_lock_on_sleep", { enabled }),
  setMobileBackgroundRun: (enabled: boolean) =>
    invoke<void>("set_mobile_background_run", { enabled }),
  mobileLeaveApp: (keepAlive: boolean) => invoke<void>("mobile_leave_app", { keepAlive }),
  factoryReset: (confirmed: boolean, confirmPhrase: string) =>
    invoke<{ steps: string[] }>("factory_reset", { confirmed, confirmPhrase }),
  applyCloseChoice: (action: "tray" | "quit" | "cancel", remember: boolean) =>
    invoke<void>("apply_close_choice", { action, remember }),
  getClosePreference: () => invoke<"tray" | "quit" | null>("get_close_preference"),
  clearClosePreference: () => invoke<void>("clear_close_preference"),

  // assets (M2)
  readSshConfig: (repair?: boolean) =>
    invoke<ConfigView>("read_ssh_config", repair ? { repair: true } : {}),
  workspaceNavCounts: () =>
    invoke<{ identities: number; keys: number; repos: number }>("workspace_nav_counts"),
  openSshConfig: () => invoke<string>("open_ssh_config"),
  scanKeys: () => invoke<ScannedKey[]>("scan_keys"),
  detectToolchain: () => invoke<Toolchain>("detect_toolchain"),
  listKeys: () => invoke<KeyRecord[]>("list_keys"),
  listIdentities: () => invoke<Identity[]>("list_identities"),
  importKey: (args: {
    privateText: string;
    publicText?: string;
    passphrase?: string;
    sourcePath?: string;
    name?: string;
  }) => invoke<KeyRecord>("import_key", { args }),
  importKeyFromPath: (path: string) => invoke<KeyRecord>("import_key_from_path", { path }),
  testConnection: (hostAlias: string) => invoke<AuthResult>("test_connection", { hostAlias }),
  openUrl: (url: string) => invoke<void>("open_url", { url }),

  // write (M3)
  generateKey: (comment: string, name?: string) => invoke<KeyRecord>("generate_key", { comment, name }),
  previewConfig: (entry: ManagedEntry) => invoke<ConfigPreview>("preview_config", { entry }),
  applyConfig: (entry: ManagedEntry) => invoke("apply_config", { entry }),
  createIdentity: (args: CreateIdentityArgs) => invoke<CreateIdentityResult>("create_identity", { args }),
  stageIdentityDraft: (args: {
    name: string;
    hostAlias: string;
    realHost: string;
    user?: string;
    strictMode: boolean;
    keyId: string;
  }) =>
    invoke<{ identityFile: string; configVerified: boolean; keyId: string }>("stage_identity_draft", { args }),
  abortIdentityDraft: (args: { hostAlias: string; keyId: string }) =>
    invoke<void>("abort_identity_draft", { args }),
  updateIdentity: (args: UpdateIdentityArgs) => invoke<Identity>("update_identity", { args }),
  deleteIdentity: (identityId: string) => invoke<void>("delete_identity", { identityId }),
  revealKeyPassphrase: (password: string, keyId: string) =>
    invoke<string>("reveal_key_passphrase", { password, keyId }),
  revealKeyMaterial: (password: string, keyId: string) =>
    invoke<RevealedKeyMaterial>("reveal_key_material", { password, keyId }),

  // agent (M4)
  agentStatus: () => invoke<AgentStatus>("agent_status"),
  agentEnsure: () => invoke<AgentStatus>("agent_ensure"),
  agentUnifyEnv: (confirmed: boolean) => invoke<AgentUnifyReport>("agent_unify_env", { confirmed }),
  agentLoad: (keyId: string) => invoke<void>("agent_load", { keyId }),
  agentLoadIdentity: (identityId: string) => invoke<void>("agent_load_identity", { identityId }),
  agentLoadAll: () => invoke<number>("agent_load_all"),
  agentUnload: (keyId: string) => invoke<void>("agent_unload", { keyId }),
  agentClear: () => invoke<void>("agent_clear"),

  // repo (M5)
  resolveUrl: (url: string) => invoke<Inference>("resolve_url", { url }),
  probeUrlIdentity: (url: string) => invoke<Inference>("probe_url_identity", { url }),
  scanRepos: (root: string, maxDepth?: number) => invoke<RepoInfo[]>("scan_repos", { root, maxDepth }),
  scanAndImportRepos: (root: string, maxDepth?: number) =>
    invoke<ImportScanResult>("scan_and_import_repos", { root, maxDepth }),
  listManagedRepos: () => invoke<ManagedRepoView[]>("list_managed_repos"),
  removeManagedRepo: (repoId: string) => invoke<void>("remove_managed_repo", { repoId }),
  setRepoRemote: (args: { repoId: string; remoteUrl: string; identityId?: string }) =>
    invoke<ManagedRepoView>("set_repo_remote", { args }),
  openRepoDir: (path: string) => invoke<void>("open_repo_dir", { path }),
  addOwner: (identityId: string, owner: string) => invoke<void>("add_owner", { identityId, owner }),
  switchRepoIdentity: (repoPath: string, identityId: string) =>
    invoke<string>("switch_repo_identity", { repoPath, identityId }),
  inspectCloneTarget: (destDir: string, repoName: string) =>
    invoke<ClonePlan>("inspect_clone_target", { destDir, repoName }),
  cloneRepo: (args: CloneOrInitArgs) => invoke<CloneResult>("clone_repo", { args }),
  githubPatStatus: () => invoke<{ configured: boolean }>("github_pat_status"),
  setGithubPat: (token: string) => invoke<void>("set_github_pat", { token }),
  clearGithubPat: () => invoke<void>("clear_github_pat"),
  testGithubPat: () => invoke<string>("test_github_pat"),
  listGithubOrgs: () => invoke<string[]>("list_github_orgs"),
  uploadPublicKey: (keyId: string, title: string) => invoke<void>("upload_public_key", { keyId, title }),
  gitPatStatus: (provider: GitProvider) =>
    invoke<{ configured: boolean }>("git_pat_status", { provider }),
  revealGitPat: (provider: GitProvider, password?: string | null) =>
    invoke<string>("reveal_git_pat", { provider, password: password ?? null }),
  setGitPat: (provider: GitProvider, token: string) =>
    invoke<void>("set_git_pat", { provider, token }),
  clearGitPat: (provider: GitProvider) => invoke<void>("clear_git_pat", { provider }),
  testGitPat: (provider: GitProvider) => invoke<string>("test_git_pat", { provider }),
  listGitOrgs: (provider: GitProvider) => invoke<string[]>("list_git_orgs", { provider }),
  uploadGitPublicKey: (provider: GitProvider, keyId: string, title: string) =>
    invoke<void>("upload_git_public_key", { provider, keyId, title }),
  ghCliStatus: () =>
    invoke<{ installed: boolean; loggedIn: boolean; login: string | null }>("gh_cli_status"),
  ghCliLogin: () =>
    invoke<{
      started: boolean;
      deviceCode: string | null;
      installed: boolean;
      loggedIn: boolean;
      login: string | null;
    }>("gh_cli_login"),
  ghCliCancel: () =>
    invoke<{ installed: boolean; loggedIn: boolean; login: string | null }>("gh_cli_cancel"),

  // backup (M6)
  exportVaultBackup: (destPath: string, password: string, accessPassword: string) =>
    invoke<BackupSummary>("export_vault_backup", { destPath, password, accessPassword }),
  inspectVaultBackup: (srcPath: string, password: string) =>
    invoke<BackupSummary>("inspect_vault_backup", { srcPath, password }),
  importVaultBackup: (srcPath: string, password: string, merge: boolean) =>
    invoke<BackupSummary>("import_vault_backup", { srcPath, password, merge }),

  // sync (v1.1)
  getCloudSyncConfig: () => invoke<S3Config | null>("get_cloud_sync_config"),
  saveCloudSyncConfig: (syncConfig: S3Config | null) =>
    invoke<void>("save_cloud_sync_config", { syncConfig }),
  verifyAccessPassword: (accessPassword: string) =>
    invoke<void>("verify_access_password", { accessPassword }),
  exportS3Config: (destPath: string, syncConfig: S3Config, accessPassword: string) =>
    invoke<void>("export_s3_config", { destPath, syncConfig, accessPassword }),
  importS3Config: (srcPath: string) => invoke<S3Config>("import_s3_config", { srcPath }),
  importS3ConfigText: (raw: string) => invoke<S3Config>("import_s3_config_text", { raw }),
  testCloudSyncConfig: (syncConfig: S3Config) =>
    invoke<number>("test_cloud_sync_config", { syncConfig }),
  getCloudSyncPage: () => invoke<CloudSyncPageData>("get_cloud_sync_page"),
  getCloudSyncStatus: (lite?: boolean) =>
    invoke<CloudSyncStatus>("get_cloud_sync_status", lite === undefined ? {} : { lite }),
  cloudSyncPush: () => invoke<SyncResult>("cloud_sync_push"),
  cloudSyncPull: () => invoke<SyncResult>("cloud_sync_pull"),
  getAutoSyncSettings: () => invoke<AutoSyncSettings>("get_auto_sync_settings"),
  setAutoSyncMinutes: (minutes: number) => invoke<number>("set_auto_sync_minutes", { minutes }),
  setAttachmentSyncGuards: (wifiOnly: boolean, manualOnly: boolean) =>
    invoke<AutoSyncSettings>("set_attachment_sync_guards", { wifiOnly, manualOnly }),
  reportNetworkUnmetered: (unmetered: boolean) =>
    invoke<void>("report_network_unmetered", { unmetered }),
  listCloudSnapshots: (force?: boolean) =>
    invoke<CloudSnapshot[]>("list_cloud_snapshots", force === undefined ? {} : { force }),
  restoreCloudSnapshot: (snapshotId: string) =>
    invoke<SyncResult>("restore_cloud_snapshot", { snapshotId }),
  runAutoSyncNow: () => invoke<SyncResult | null>("run_auto_sync_now"),
  previewCloudRestore: (syncConfig: S3Config, recoveryKey: string) =>
    invoke<CloudRestorePreview>("preview_cloud_restore", { syncConfig, recoveryKey }),
    restoreFromCloud: (args: {
      path: string;
      password: string;
      recoveryKey: string;
      syncConfig: S3Config;
      includeRepos?: boolean;
    }) => invoke<SyncResult>("restore_from_cloud", args),

  // update (M7)
  getUpdateSource: () => invoke<UpdateSource>("get_update_source"),
  saveUpdateSource: (source: UpdateSource | null) => invoke<void>("save_update_source", { source }),
  getAutoCheckUpdate: () => invoke<boolean>("get_auto_check_update"),
  setAutoCheckUpdate: (enabled: boolean) => invoke<void>("set_auto_check_update", { enabled }),
  checkUpdate: () => invoke<UpdateCheckResult>("check_update"),
  downloadAndInstallUpdate: () => invoke<void>("download_and_install_update"),
  skipUpdateVersion: (version: string) => invoke<void>("skip_update_version", { version }),
  getLastUpdateCheck: () => invoke<string | null>("get_last_update_check"),

  getUiLocale: () => invoke<"system" | "zh" | "en">("get_ui_locale"),
  setUiLocale: (locale: "system" | "zh" | "en") =>
    invoke<"system" | "zh" | "en">("set_ui_locale", { locale }),

  getNetworkProxy: () => invoke<NetworkProxy | null>("get_network_proxy"),
  saveNetworkProxy: (proxy: NetworkProxy | null) => invoke<void>("save_network_proxy", { proxy }),
  testNetworkProxy: (proxy: NetworkProxy) => invoke<ProxyTestResult>("test_network_proxy", { proxy }),

  totpList: () => invoke<{ entries: TotpEntry[]; groups: GroupMeta[] }>("totp_list"),
  totpAdd: (args: TotpUpsertArgs) => invoke<TotpEntry>("totp_add", { args }),
  totpUpdate: (args: TotpUpsertArgs) => invoke<TotpEntry>("totp_update", { args }),
  totpDelete: (id: string) => invoke<void>("totp_delete", { id }),
  totpSaveGroups: (groups: GroupMeta[]) => invoke<void>("totp_save_groups", { groups }),
  totpGenerateCode: (id: string, password?: string) =>
    invoke<TotpCode>("totp_generate_code", { id, password: password ?? null }),
  totpParseUri: (uri: string) => invoke<ParsedTotpPreview>("totp_parse_uri", { uri }),
  totpParseImport: (text: string) => invoke<TotpImportResult>("totp_parse_import", { text }),
  totpImportFromImage: (path: string) => invoke<TotpImportResult>("totp_import_from_image", { path }),
  totpScanScreen: () => invoke<ScreenHit[]>("totp_scan_screen"),
  renderQrPng: (text: string) => invoke<string>("render_qr_png", { text }),
  decodeQrFromImage: (bytes: number[]) => invoke<string[]>("decode_qr_from_image", { bytes }),
  requestCameraPermission: () =>
    invoke<CameraPermissionStatus>("request_camera_permission"),
  openAppPermissionSettings: () => invoke<void>("open_app_permission_settings"),
  totpRevealSecret: (id: string, password: string) =>
    invoke<TotpSecretReveal>("totp_reveal_secret", { id, password }),
  totpExportQr: (id: string, password: string) => invoke<string>("totp_export_qr", { id, password }),

  accountList: () => invoke<{ entries: AccountEntry[]; groups: GroupMeta[] }>("account_list"),
  accountAdd: (args: AccountUpsertArgs) => invoke<AccountEntry>("account_add", { args }),
  accountUpdate: (args: AccountUpsertArgs) => invoke<AccountEntry>("account_update", { args }),
  accountDelete: (id: string) => invoke<void>("account_delete", { id }),
  accountSaveGroups: (groups: GroupMeta[]) => invoke<void>("account_save_groups", { groups }),
  accountRevealPassword: (id: string, password?: string) =>
    invoke<AccountReveal>("account_reveal_password", { id, password: password ?? null }),
  accountTouch: (id: string) => invoke<void>("account_touch", { id }),
  accountHistoryList: (id: string) => invoke<HistoryMeta[]>("account_history_list", { id }),
  accountRevealHistory: (id: string, index: number, password?: string) =>
    invoke<string>("account_reveal_history", { id, index, password: password ?? null }),
  accountRollbackHistory: (id: string, index: number) =>
    invoke<void>("account_rollback_history", { id, index }),
  accountClearHistory: (id: string) => invoke<void>("account_clear_history", { id }),

  fileList: () => invoke<FileVaultList>("file_list"),
  fileAddFromPath: (path: string, args?: FileAddArgs) =>
    invoke<FileEntry>("file_add_from_path", { path, args: args ?? null }),
  fileAddFromPaths: (paths: string[], args?: FileAddArgs) =>
    invoke<FileEntry>("file_add_from_paths", { paths, args: args ?? null }),
  fileAddBytes: (originalName: string, bytes: number[], args?: FileAddArgs) =>
    invoke<FileEntry>("file_add_bytes", { originalName, bytes, args: args ?? null }),
  fileAddBytesMany: (items: FileBytesItem[], args?: FileAddArgs) =>
    invoke<FileEntry>("file_add_bytes_many", { items, args: args ?? null }),
  fileUpdate: (id: string, args: FileUpdateArgs) => invoke<FileEntry>("file_update", { id, args }),
  fileDelete: (id: string) => invoke<void>("file_delete", { id }),
  fileExport: (id: string, destPath: string, password?: string, attachmentId?: string) =>
    invoke<void>("file_export", {
      id,
      destPath,
      password: password ?? null,
      attachmentId: attachmentId ?? null,
    }),
  fileSaveGroups: (groups: GroupMeta[]) => invoke<void>("file_save_groups", { groups }),

  noteList: () => invoke<NoteList>("note_list"),
  noteGetBody: (id: string) => invoke<NoteBody>("note_get_body", { id }),
  noteUpsert: (args: NoteUpsertArgs) => invoke<NoteEntry>("note_upsert", { args }),
  noteDelete: (id: string) => invoke<void>("note_delete", { id }),
  noteAssetAdd: (args: { path?: string; bytes?: number[] }) =>
    invoke<NoteAssetAddResult>("note_asset_add", { path: args.path ?? null, bytes: args.bytes ?? null }),
  noteAssetGet: (hash: string) => invoke<string>("note_asset_get", { hash }),
  noteSaveGroups: (groups: GroupMeta[]) => invoke<void>("note_save_groups", { groups }),
  noteExport: (id: string, destPath: string, mode?: string) =>
    invoke<void>("note_export", { id, destPath, mode: mode ?? null }),
  noteExportContent: (id: string, mode?: string) =>
    invoke<string>("note_export_content", { id, mode: mode ?? null }),
  noteWriteExportFile: (destPath: string, bytes: number[]) =>
    invoke<void>("note_write_export_file", { destPath, bytes }),

  clipboardWrite: (text: string, secret = false) =>
    invoke<ClipboardWriteResult>("clipboard_write", { text, secret }),
  clipboardRead: () => invoke<string>("clipboard_read"),
  clipboardClear: () => invoke<void>("clipboard_clear"),
  getRevealSettings: () => invoke<RevealSettings>("get_reveal_settings"),
  setRevealGraceMinutes: (minutes: number) => invoke<number>("set_reveal_grace_minutes", { minutes }),
  setClipboardClearSeconds: (seconds: number) =>
    invoke<number>("set_clipboard_clear_seconds", { seconds }),
  getClipboardWatch: () => invoke<boolean>("get_clipboard_watch"),
  setClipboardWatch: (enabled: boolean) => invoke<boolean>("set_clipboard_watch", { enabled }),
  setAccountHistoryLimit: (limit: number) => invoke<number>("set_account_history_limit", { limit }),
  getScreenCaptureSettings: () => invoke<ScreenCaptureSettings>("get_screen_capture_settings"),
  setAllowScreenshots: (allow: boolean) =>
    invoke<ScreenCaptureSettings>("set_allow_screenshots", { allow }),
  iconListBuiltin: () => invoke<BuiltinIconInfo[]>("icon_list_builtin"),
  iconUploadCustom: (filePath: string) => invoke<CustomIconInfo>("icon_upload_custom", { filePath }),
  iconGetCustom: (iconRef: string) => invoke<string>("icon_get_custom", { iconRef }),

  securityChecklist: () => invoke<SecurityChecklist>("security_checklist"),
};

function rawErrorText(e: unknown): string {
  if (e == null) return "";
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message || e.name || String(e);
  if (typeof e === "object") {
    const o = e as Record<string, unknown>;
    if (typeof o.message === "string" && o.message.trim()) return o.message;
    if (typeof o.error === "string" && o.error.trim()) return o.error;
  }
  return String(e);
}

const CMD_MISSING = /command\s*([a-z][a-z0-9_]*)\s*not\s*found/i;
const CMD_MISSING_COMPACT = /^command([a-z][a-z0-9_]*)notfound$/i;
const CMD_DENIED = /command\s*([a-z][a-z0-9_]*)\s*not\s*allowed/i;

/** 把 IPC / 异常收成可读句子。Android WebView 有时会把空格挤掉。 */
export function errMessage(e: unknown): string {
  const raw = rawErrorText(e).replace(/[\u00a0\s]+/g, " ").trim();
  const compact = raw.replace(/\s+/g, "");
  const missing = raw.match(CMD_MISSING) || compact.match(CMD_MISSING_COMPACT);
  if (missing?.[1]) return i18n.t("common.commandMissing", { cmd: missing[1] });
  const denied = raw.match(CMD_DENIED);
  if (denied?.[1]) return i18n.t("common.commandDenied", { cmd: denied[1] });
  return raw || String(e);
}

export function errCode(e: unknown): string {
  if (e && typeof e === "object" && "code" in e) return String((e as AppErrorShape).code);
  return "";
}

export interface GroupMeta {
  name: string;
  color?: string | null;
  sortOrder: number;
}

export interface TotpEntry {
  id: string;
  issuer: string;
  account: string;
  note?: string | null;
  url?: string | null;
  group?: string | null;
  algorithm: string;
  digits: number;
  period: number;
  icon?: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  hasSeed?: boolean;
}

export interface FileAttachment {
  id: string;
  originalName: string;
  mime?: string | null;
  size: number;
  sha256: string;
}

export interface FileEntry {
  id: string;
  name: string;
  originalName: string;
  mime?: string | null;
  size: number;
  sha256: string;
  attachments?: FileAttachment[];
  group?: string | null;
  note?: string | null;
  icon?: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface FileVaultList {
  entries: FileEntry[];
  groups: GroupMeta[];
  usageBytes: number;
}

export interface FileAddArgs {
  name?: string;
  note?: string;
  group?: string;
}

export interface FileBytesItem {
  originalName: string;
  bytes: number[];
}

export interface FileUpdateArgs {
  name?: string;
  note?: string;
  group?: string;
  icon?: string;
  sortOrder?: number;
  keepAttachmentIds?: string[];
  addPaths?: string[];
  addBytes?: FileBytesItem[];
}

export function entryAttachments(e: FileEntry): FileAttachment[] {
  if (e.attachments && e.attachments.length > 0) return e.attachments;
  if (e.sha256) {
    return [
      {
        id: e.sha256,
        originalName: e.originalName,
        mime: e.mime,
        size: e.size,
        sha256: e.sha256,
      },
    ];
  }
  return [];
}

export interface NoteEntry {
  id: string;
  title: string;
  format: string;
  group?: string | null;
  tags: string[];
  icon?: string | null;
  pinned: boolean;
  sortOrder: number;
  excerpt?: string | null;
  bodySha256: string;
  assetHashes: string[];
  createdAt: string;
  updatedAt: string;
}

export interface NoteList {
  entries: NoteEntry[];
  groups: GroupMeta[];
}

export interface NoteBody {
  format: string;
  markdown: string;
}

export interface NoteUpsertArgs {
  id?: string;
  title: string;
  format?: string;
  tags?: string[];
  group?: string;
  icon?: string;
  pinned?: boolean;
  markdown: string;
}

export interface NoteAssetAddResult {
  hash: string;
}

export interface AccountEntry {
  id: string;
  platform: string;
  username: string;
  displayName?: string | null;
  url?: string | null;
  note?: string | null;
  group?: string | null;
  tags: string[];
  icon?: string | null;
  pinned: boolean;
  sortOrder: number;
  totpRef?: string | null;
  lastUsedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  hasPassword?: boolean;
  extraFieldKeys?: string[];
}

export interface AccountReveal {
  password: string;
  extraFields: Record<string, string>;
}

export interface TotpCode {
  code: string;
  period: number;
  remainingSeconds: number;
}

export interface TotpSecretReveal {
  secretBase32: string;
  otpauthUri: string;
  qrPngBase64: string;
}

export interface ParsedTotpPreview {
  issuer: string;
  account: string;
  algorithm: string;
  digits: number;
  period: number;
  suggestedIcon?: string | null;
  secret?: string;
}

export interface TotpImportResult {
  source: "otpauth" | "google-migration" | string;
  entries: ParsedTotpPreview[];
  skippedHotp: number;
  batchIndex: number;
  batchSize: number;
}

export interface ScreenHit {
  display: string;
  uri: string;
  parsed: { issuer: string; account: string; algorithm: string; digits: number; period: number; secret?: string };
}

export interface HistoryMeta {
  index: number;
  replacedAt: string;
}

export interface BuiltinIconInfo {
  id: string;
  name: string;
  color: string;
  glyph: string;
}

export interface CustomIconInfo {
  iconRef: string;
  dataUrl: string;
  bytes: number;
}

export interface RevealSettings {
  revealGraceMinutes: number;
  clipboardClearSeconds: number;
  accountHistoryLimit: number;
}

export type ScreenCaptureCapability = "exclude" | "overlay" | "unsupported";

export interface ScreenCaptureSettings {
  allowScreenshots: boolean;
  capability: ScreenCaptureCapability;
}

export type SecuritySeverity = "ok" | "info" | "warn";
export type SecurityLevel = "safe" | "caution" | "risk";
export type SecurityCategory = "storage" | "app";

export interface SecurityFinding {
  id: string;
  category: SecurityCategory;
  severity: SecuritySeverity;
  title: string;
  detail: string;
  advice: string;
  settingsAnchor?: string | null;
  limitation?: string | null;
}

export interface SecurityChecklist {
  checkedAt: string;
  level: SecurityLevel;
  items: SecurityFinding[];
}

export interface ClipboardWriteResult {
  excluded: boolean;
  fallback: boolean;
  notice?: string | null;
}

export interface TotpUpsertArgs {
  id?: string;
  issuer: string;
  account: string;
  secret?: string;
  note?: string;
  url?: string;
  group?: string;
  algorithm?: string;
  digits?: number;
  period?: number;
  icon?: string;
  sortOrder?: number;
}

export interface AccountUpsertArgs {
  id?: string;
  platform: string;
  username: string;
  password?: string;
  displayName?: string;
  url?: string;
  note?: string;
  group?: string;
  tags?: string[];
  icon?: string;
  pinned?: boolean;
  sortOrder?: number;
  totpRef?: string;
  extraFields?: Record<string, string>;
}
