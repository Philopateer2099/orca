import { toast } from 'sonner'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { SourceControlAiSettingsPatch } from '../../../../../shared/source-control/ai/settings/source-control-ai-settings-types'
import { resolveSourceControlAiForOperation } from '../../../../../shared/source-control/ai/source-control-ai-operation-resolution'
import { CUSTOM_AGENT_ID } from '../../../../../shared/source-control/ai/generation/commit-message-agent-spec'
import { getAgentLabel } from '@/lib/agent-catalog/agent-catalog'
import { useTranslate } from '@/i18n/use-translate'
import { Switch } from '../../ui/switch'
import { Card, CardContent } from '../../ui/card'
import { SourceControlActionRecipeRow } from '../source-control/SourceControlActionRecipeRow'
import { useGlobalTextActionRecipeDraft } from '../source-control/use-global-text-action-recipe-draft'
import { CustomAgentCommandField } from '../source-control/CustomAgentCommandField'
import { SettingsSubsectionHeader } from '../form-controls/SettingsFormControls'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { getChatNamingSearchEntry } from './chat-naming-search'
import { AppearanceAdvancedDisclosure } from '../appearance/AppearanceAdvancedDisclosure'

type ChatNamingSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
  writeSourceControlAiSettings: (patch: SourceControlAiSettingsPatch) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
  forceVisible?: boolean
}

export function ChatNamingSetting({
  settings,
  updateSettings,
  writeSourceControlAiSettings,
  onDirtyChange,
  forceVisible = false
}: ChatNamingSettingProps): React.JSX.Element {
  const t = useTranslate()
  const {
    config,
    recipe,
    persisted,
    value,
    dirty,
    customCommand,
    customCommandDirty,
    isSaving,
    clearDirtyOnUnmount,
    updateDraft,
    updateCustomCommandDraft,
    discard,
    save,
    saveAgent,
    appendVariable
  } = useGlobalTextActionRecipeDraft({
    actionId: 'conversationName',
    settings,
    writeSourceControlAiSettings,
    onDirtyChange,
    onSaveError: (error) => {
      console.error('Failed to save chat name recipe', error)
      toast.error(t('settings.chat.names.saveFailed', 'Could not save chat name settings.'))
    }
  })

  const cliRecipe = value.agentArgs?.trim()
    ? resolveSourceControlAiForOperation({
        settings: {
          ...settings,
          sourceControlAi: {
            ...config,
            actions: {
              ...config.actions,
              conversationName: {
                ...recipe,
                ...value,
                ...(recipe?.agentId ? { agentId: null } : {})
              }
            }
          }
        },
        operation: 'conversationName'
      })
    : null
  const cliAgent = cliRecipe?.ok ? cliRecipe.value.params.agentId : null
  const defaultAgentLabel = cliAgent
    ? t('settings.chat.names.configuredCliAgent', 'Use configured CLI agent ({{agent}})', {
        agent:
          cliAgent === 'custom'
            ? t(
                'auto.components.settings.SourceControlAiActionRecipeDefaults.0740d30915',
                'Custom command'
              )
            : getAgentLabel(cliAgent)
      })
    : cliRecipe
      ? t('settings.chat.names.configuredCliAgentUnknown', 'Use configured CLI agent')
      : t('settings.chat.names.useChatAgent', 'Use chat agent')
  const searchEntry = getChatNamingSearchEntry()
  return (
    <SearchableSetting
      {...searchEntry}
      id="chat-names"
      forceVisible={forceVisible || dirty}
      className="max-w-none space-y-3"
    >
      <SettingsSubsectionHeader title={searchEntry.title} />
      <Card>
        <CardContent>
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">{searchEntry.description}</p>
              </div>
              <Switch
                aria-label={t('settings.chat.names.enable', 'Name chats automatically')}
                checked={settings.nativeChatAutoName !== false}
                onCheckedChange={(checked) => updateSettings({ nativeChatAutoName: checked })}
              />
            </div>
            {settings.nativeChatAutoName !== false || dirty ? (
              <AppearanceAdvancedDisclosure
                forceOpen={dirty || isSaving}
                contentClassName="space-y-3 pt-3"
              >
                {recipe?.agentId === CUSTOM_AGENT_ID ||
                cliAgent === CUSTOM_AGENT_ID ||
                customCommandDirty ? (
                  <CustomAgentCommandField
                    id="chat-name-custom-command"
                    value={customCommand}
                    onChange={updateCustomCommandDraft}
                    description={t(
                      'settings.chat.names.customCommandDescription',
                      'Command line shared by recipes that select Custom command. Use {prompt} to pass the input as an argument; otherwise it is piped to stdin.'
                    )}
                  />
                ) : null}
                <SourceControlActionRecipeRow
                  actionId="conversationName"
                  source={config}
                  onTextModelChoiceChange={(_id, modelChoice, agentArgs, modelEdits) =>
                    updateDraft({ ...value, modelChoice, agentArgs, modelEdits })
                  }
                  writeSourceControlAiSettings={writeSourceControlAiSettings}
                  selectedAgent={recipe?.agentId ?? null}
                  defaultAgentLabel={defaultAgentLabel}
                  defaultAgentSupportText={
                    cliRecipe && !cliRecipe.ok
                      ? cliRecipe.error
                      : cliRecipe
                        ? t(
                            'settings.chat.names.clearCliArguments',
                            'Clear CLI arguments to use each chat’s agent.'
                          )
                        : undefined
                  }
                  defaultAgentArgsPlaceholder={
                    cliAgent
                      ? undefined
                      : t(
                          'settings.chat.names.cliArgumentsPlaceholder',
                          'Optional arguments for a configured CLI naming agent'
                        )
                  }

                  draftValue={value}
                  baseValue={persisted}
                  hasUnsavedChanges={dirty}
                  defaultTuiAgent={
                    cliAgent && cliAgent !== 'custom' ? cliAgent : settings.defaultTuiAgent
                  }
                  isSavingTemplate={isSaving}
                  onAgentChange={(_id, selected) => void saveAgent(selected)}
                  onTemplateChange={(_id, template) =>
                    updateDraft({ ...value, commandInputTemplate: template })
                  }
                  onAgentArgsChange={(_id, agentArgs) => updateDraft({ ...value, agentArgs })}
                  onAppendVariable={(_id, variable) => appendVariable(variable)}
                  onDiscard={discard}
                  onSave={() => void save()}
                />
              </AppearanceAdvancedDisclosure>
            ) : null}
          </div>
        </CardContent>
      </Card>
      <span ref={clearDirtyOnUnmount} />
    </SearchableSetting>
  )
}
