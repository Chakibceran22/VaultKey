import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { PencilSimple, Plus, Trash } from '@phosphor-icons/react'
import { useQueryClient } from '@tanstack/react-query'
import type { AccountSecretMeta, Factor, FactorKind } from '@renderer/shared/contracts'
import { AccountModal } from '@renderer/components/accounts/AccountModal'
import { AccountSecretModal } from '@renderer/components/accounts/AccountSecretModal'
import { FactorModal } from '@renderer/components/accounts/FactorModal'
import { DEVICES, FACTOR_KINDS, FACTORS } from '@renderer/components/accounts/kinds'
import { RelatedGroup } from '@renderer/components/accounts/parts'
import {
  AccountSecretRow,
  EmailWay,
  FactorWay,
  NoPasswordWay,
  PasswordWay,
  RecoveryAccountWay,
  SignInWithWay,
  UsernameWay
} from '@renderer/components/accounts/sections'
import {
  EmptyFrame,
  EmptyLine,
  History,
  ListFrame,
  Page,
  PageHeader,
  RecordColumns,
  Section,
  useShowSection
} from '@renderer/components/layout/page'
import { Button } from '@renderer/components/ui/button'
import { useConfirm } from '@renderer/components/ui/confirm'
import { SiteTile, Spinner } from '@renderer/components/ui/misc'
import { RowMenu, RowMenuItem } from '@renderer/components/ui/overlays'
import {
  plural,
  refreshVault,
  useAccountDetails,
  useAccounts,
  useRelations
} from '@renderer/hooks/use-vault'
import { api } from '@renderer/lib/api'
import { guessCategory } from '@renderer/lib/categories'
import { credentialsService } from '@renderer/lib/credentialsService'
import { unwrap } from '@renderer/lib/ipc'
import { toast } from '@renderer/lib/toast'

/** Kept after closing, so a modal's content doesn't change while it fades out. */
type ModalState =
  | { open: boolean; kind: 'account' }
  | { open: boolean; kind: 'factor'; factor: Factor | null }
  | { open: boolean; kind: 'secret'; secret: AccountSecretMeta | null }

/**
 * Pattern: Detail / Record. One account and everything it takes to get into it,
 * on one screen: how it signs in, its second steps and recovery, and the secrets
 * and notes kept with it; beside them, what it connects to. Adding and editing
 * happen in a modal.
 */
export default function AccountPage(): React.ReactElement {
  // A fresh page per account: nothing shown, typed or open carries over to the next one.
  const { accountId } = useParams()
  return <AccountView key={accountId} accountId={Number(accountId)} />
}

function AccountView({ accountId }: { accountId: number }): React.ReactElement {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { accounts, isLoading } = useAccounts()
  const { devices } = useAccountDetails()
  const relationsOf = useRelations()
  const { confirm, dialog } = useConfirm()
  const [modal, setModal] = useState<ModalState>({ open: false, kind: 'account' })
  const closeModal = (): void => setModal((current) => ({ ...current, open: false }))

  const account = accounts.find((a) => a.id === accountId)
  const relations = relationsOf(accountId)
  useShowSection(!!account)

  if (!account) {
    return (
      <Page>
        <PageHeader crumbs={[{ to: '/accounts', label: 'Accounts' }]} title="Account" />
        <div className="mt-8">
          {isLoading ? (
            <div className="flex justify-center py-16 text-muted-foreground">
              <Spinner size={20} />
            </div>
          ) : (
            <EmptyFrame
              title="This account no longer exists"
              description="It may have been deleted. Everything else in the vault is still there."
              action={
                <Button variant="primary" size="lg" onClick={() => navigate('/accounts')}>
                  Back to accounts
                </Button>
              }
            />
          )}
        </div>
      </Page>
    )
  }

  const deviceById = new Map(devices.map((d) => [d.id, d]))
  const steps = [...relations.factors].sort(
    (a, b) => FACTOR_KINDS.indexOf(a.kind) - FACTOR_KINDS.indexOf(b.kind) || a.id - b.id
  )
  const openDevice = (deviceId: number): void => {
    navigate(`/devices?open=${deviceId}`)
  }

  const removeAccount = async (): Promise<void> => {
    const steps = relations.factors.length
    const kept = relations.secrets.length
    const consequences = [
      steps + kept > 0 &&
        `Its ${[
          steps && plural(steps, 'sign-in step'),
          kept && `${kept} ${kept === 1 ? 'secret or note' : 'secrets and notes'}`
        ]
          .filter(Boolean)
          .join(' and ')} go with it.`,
      relations.usedBy.length > 0 &&
        `${relations.usedBy.map((a) => a.domainName).join(', ')} will no longer show that they sign in with it.`,
      relations.services.length > 0 &&
        `${relations.services.length === 1 ? 'One service' : `${relations.services.length} services`} will be left without an account.`
    ].filter(Boolean)
    const ok = await confirm({
      title: `Delete this ${account.domainName} account?`,
      description: [`${account.email} will be removed for good.`, ...consequences].join(' '),
      confirmLabel: 'Delete account',
      destructive: true
    })
    if (!ok) return
    try {
      await credentialsService.deleteCredential(account.id)
      navigate('/accounts', { replace: true })
      await refreshVault(queryClient, account.domainId)
      toast.success('Account deleted')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete the account')
    }
  }

  const removeFactor = async (factor: Factor): Promise<void> => {
    const name = FACTORS[factor.kind].name.toLowerCase()
    const ok = await confirm({
      title: `Remove the ${name} from ${account.domainName}?`,
      description: `VaultKey forgets it${factor.hasSecret ? ', with what is saved for it' : ''}. Nothing changes on ${account.domainName} itself.`,
      confirmLabel: `Remove ${name}`,
      destructive: true
    })
    if (!ok) return
    try {
      unwrap(await api.deleteFactor(factor.id))
      await refreshVault(queryClient)
      toast.success(`${FACTORS[factor.kind].name} removed`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t remove it')
    }
  }

  const removeSecret = async (secret: AccountSecretMeta): Promise<void> => {
    const what = secret.kind === 'note' ? 'note' : 'secret'
    const ok = await confirm({
      title: `Delete “${secret.name}” from ${account.domainName}?`,
      description: `The ${what} is removed for good.`,
      confirmLabel: `Delete ${what}`,
      destructive: true
    })
    if (!ok) return
    try {
      unwrap(await api.deleteAccountSecret(secret.id))
      await refreshVault(queryClient)
      toast.success(secret.kind === 'note' ? 'Note deleted' : 'Secret deleted')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t delete it')
    }
  }

  const addStep = (): void => setModal({ open: true, kind: 'factor', factor: null })
  const addSecret = (): void => setModal({ open: true, kind: 'secret', secret: null })
  const editAccount = (): void => setModal({ open: true, kind: 'account' })

  // What protects it, at a glance: one quiet chip per kind.
  const kinds = [...new Set(steps.map((f) => f.kind))] as FactorKind[]
  const protections = [
    relations.signsInWith.length
      ? { key: 'via', label: `Signs in with ${relations.signsInWith[0].domainName}` }
      : account.hasPassword
        ? { key: 'pw', label: 'Password' }
        : { key: 'none', label: 'No password' },
    ...kinds.map((kind) => {
      const n = steps.filter((f) => f.kind === kind).length
      return { key: kind, label: n > 1 ? `${FACTORS[kind].name} ×${n}` : FACTORS[kind].name, icon: FACTORS[kind].icon }
    })
  ]

  return (
    <Page wide>
      <PageHeader
        crumbs={[{ to: '/accounts', label: 'Accounts' }]}
        actionsAtTop
        title={
          <span className="flex items-center gap-3">
            <SiteTile name={account.domainName} size="md" />
            <span className="min-w-0 truncate">{account.domainName}</span>
          </span>
        }
        description={
          <div className="space-y-2.5">
            <p className="truncate" data-selectable>
              {account.email}
              {account.username && <span className="text-muted-foreground/80">, {account.username}</span>}
            </p>
            <ul aria-label="How it is protected" className="flex flex-wrap gap-1.5">
              {protections.map((p) => {
                const ChipIcon = 'icon' in p ? p.icon : undefined
                return (
                  <li
                    key={p.key}
                    className="inline-flex h-6 items-center gap-1.5 rounded-md border bg-background/40 px-2 text-[12px] text-muted-foreground dark:bg-white/4"
                  >
                    {ChipIcon && <ChipIcon size={13} />}
                    {p.label}
                  </li>
                )
              })}
              {kinds.length === 0 && relations.signsInWith.length === 0 && (
                <li className="inline-flex h-6 items-center rounded-md border border-dashed px-2 text-[12px] text-muted-foreground">
                  No second step saved
                </li>
              )}
            </ul>
          </div>
        }
        actions={
          <>
            <Button size="lg" onClick={editAccount}>
              <PencilSimple size={14} />
              Edit
            </Button>
            <RowMenu label="Account actions">
              <RowMenuItem icon={Trash} tone="destructive" onClick={() => void removeAccount()}>
                Delete account
              </RowMenuItem>
            </RowMenu>
          </>
        }
      />

      <RecordColumns
        main={
          <>
            <Section
              id="section-sign-in"
              title="Sign-in"
              action={
                <Button size="md" onClick={addStep}>
                  <Plus size={13} weight="bold" />
                  Add sign-in step
                </Button>
              }
            >
              <ListFrame>
                <EmailWay account={account} />
                {account.username && <UsernameWay username={account.username} />}
                {relations.signsInWith.length > 0 ? (
                  <SignInWithWay accounts={relations.signsInWith} />
                ) : account.hasPassword ? (
                  <PasswordWay account={account} />
                ) : (
                  <NoPasswordWay />
                )}
                {steps.map((factor) => (
                  <FactorWay
                    // Re-keyed on edit, so codes shown before the edit don't linger.
                    key={`${factor.id}-${factor.updatedAt}`}
                    factor={factor}
                    device={factor.deviceId ? deviceById.get(factor.deviceId) : undefined}
                    onEdit={() => setModal({ open: true, kind: 'factor', factor })}
                    onDelete={() => void removeFactor(factor)}
                    onOpenDevice={openDevice}
                  />
                ))}
                {relations.recoveredBy.length > 0 && <RecoveryAccountWay accounts={relations.recoveredBy} />}
                {steps.length === 0 && relations.signsInWith.length === 0 && (
                  <EmptyLine title="No second step saved.">
                    Add the authenticator app, passkeys, security keys or recovery codes it uses, so getting back in never
                    depends on remembering them.
                  </EmptyLine>
                )}
              </ListFrame>
              {steps.length === 0 && relations.signsInWith.length > 0 && (
                <p className="mt-3 px-1 text-[12.5px] leading-relaxed text-muted-foreground">
                  It signs in with {relations.signsInWith.map((a) => a.domainName).join(' or ')}, so the second steps that
                  matter are saved there. Add one here only if {account.domainName} asks for its own.
                </p>
              )}
            </Section>

            <Section
              id="section-secrets"
              title="Secrets and notes"
              action={
                <Button size="md" onClick={addSecret}>
                  <Plus size={13} weight="bold" />
                  Add secret or note
                </Button>
              }
            >
              <ListFrame footer={relations.secrets.length > 0 ? plural(relations.secrets.length, 'item') : undefined}>
                {relations.secrets.map((secret) => (
                  <AccountSecretRow
                    key={secret.id}
                    secret={secret}
                    onEdit={() => setModal({ open: true, kind: 'secret', secret })}
                    onDelete={() => void removeSecret(secret)}
                  />
                ))}
                {relations.secrets.length === 0 && (
                  <EmptyLine title="None yet.">
                    Tokens and keys that belong to this account, or anything about it you would otherwise have to
                    remember. Kept encrypted.
                  </EmptyLine>
                )}
              </ListFrame>
            </Section>
          </>
        }
        side={
          <>
            <Section
              title="Connections"
              action={
                <Button size="sm" variant="ghost" aria-label="Edit connections" onClick={editAccount}>
                  <PencilSimple size={13} />
                  Edit
                </Button>
              }
            >
              <div className="frost divide-y divide-border overflow-hidden rounded-2xl">
                <RelatedGroup
                  label="Signs in to"
                  empty="No account signs in with it"
                  items={relations.usedBy.map((a) => ({
                    key: `in-${a.id}`,
                    title: a.domainName,
                    detail: a.email,
                    onOpen: () => navigate(`/accounts/${a.id}`)
                  }))}
                />
                <RelatedGroup
                  label="Recovers"
                  empty="It isn’t a recovery account"
                  items={relations.recovers.map((a) => ({
                    key: `rec-${a.id}`,
                    title: a.domainName,
                    detail: a.email,
                    onOpen: () => navigate(`/accounts/${a.id}`)
                  }))}
                />
                <RelatedGroup
                  label="Signed in on"
                  empty="No device noted"
                  items={relations.devices.map((d) => ({
                    key: `dev-${d.id}`,
                    title: d.name,
                    detail: d.note ? `${DEVICES[d.kind].name} · ${d.note}` : DEVICES[d.kind].name,
                    icon: DEVICES[d.kind].icon,
                    onOpen: () => openDevice(d.id)
                  }))}
                />
                <RelatedGroup
                  label="Used in projects"
                  empty="No project uses it"
                  items={relations.services.map(({ service, project, role }) => ({
                    key: `svc-${service.id}`,
                    title: service.name,
                    detail: role ? `${project.name} · ${role}` : project.name,
                    onOpen: () => navigate(`/projects/${project.id}?show=services`)
                  }))}
                />
              </div>
              <p className="mt-3 px-1 text-[12px] leading-relaxed text-muted-foreground">
                “Signs in to” and “Recovers” are set on the other account.
              </p>
            </Section>
            <History
              createdAt={account.createdAt}
              updatedAt={account.updatedAt}
              facts={[
                [
                  'Group',
                  account.category ?? (
                    <>
                      {guessCategory(account.domainName)}
                      <span className="text-muted-foreground">, guessed</span>
                    </>
                  )
                ]
              ]}
            />
          </>
        }
      />

      {modal.kind === 'account' && (
        <AccountModal
          open={modal.open}
          onOpenChange={(open) => !open && closeModal()}
          account={account}
        />
      )}
      {modal.kind === 'factor' && (
        <FactorModal
          open={modal.open}
          onOpenChange={(open) => !open && closeModal()}
          account={account}
          factor={modal.factor}
        />
      )}
      {modal.kind === 'secret' && (
        <AccountSecretModal
          open={modal.open}
          onOpenChange={(open) => !open && closeModal()}
          account={account}
          secret={modal.secret}
        />
      )}
      {dialog}
    </Page>
  )
}

