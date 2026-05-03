// Thunderbird MailExtension API declarations not covered by @types/firefox-webext-browser

declare namespace browser {
  namespace compose {
    interface ComposeAttachment {
      id: number   // integer, not string
      name: string
      size?: number
    }

    interface ComposeRecipient {
      email: string
      name?: string
    }

    type ComposeRecipientList = string | ComposeRecipient | Array<string | ComposeRecipient>

    interface ComposeDetails {
      from?: string | ComposeRecipient
      to?: ComposeRecipientList
      cc?: ComposeRecipientList
      bcc?: ComposeRecipientList
      replyTo?: ComposeRecipientList
      subject?: string
      body?: string
      plainTextBody?: string
      isPlainText?: boolean
      attachments?: ComposeAttachment[]
    }

    interface OnBeforeSendResult {
      cancel?: boolean
      details?: Partial<ComposeDetails>
    }

    interface SendMessageOptions {
      mode?: 'default' | 'sendNow' | 'sendLater'
    }

    function listAttachments(tabId: number): Promise<ComposeAttachment[]>
    function getAttachmentFile(attachmentId: number): Promise<File>
    function removeAttachment(tabId: number, attachmentId: number): Promise<void>
    function getComposeDetails(tabId: number): Promise<ComposeDetails>
    function setComposeDetails(tabId: number, details: Partial<ComposeDetails>): Promise<void>
    function sendMessage(tabId: number, options?: SendMessageOptions): Promise<boolean>
    const onBeforeSend: {
      addListener(
        callback: (
          tab: browser.tabs.Tab,
          details: ComposeDetails,
        ) => Promise<OnBeforeSendResult | void> | OnBeforeSendResult | void,
      ): void
      removeListener(callback: (tab: browser.tabs.Tab, details: ComposeDetails) => unknown): void
      hasListener(callback: (tab: browser.tabs.Tab, details: ComposeDetails) => unknown): boolean
    }
  }

  namespace windows {
    interface _CreateCreateData {
      url?: string
      type?: 'normal' | 'popup' | 'panel' | 'detached_panel'
      width?: number
      height?: number
      left?: number
      top?: number
    }
  }

  namespace browserAction {
    function openPopup(): Promise<void>
  }

  namespace composeAction {
    interface SetTitleDetails {
      title: string
      tabId?: number
      windowId?: number
    }
    interface SetBadgeTextDetails {
      text: string
      tabId?: number
      windowId?: number
    }
    type ColorArray = [number, number, number, number]
    interface SetBadgeBackgroundColorDetails {
      color: string | ColorArray | null
      tabId?: number
      windowId?: number
    }
    function setTitle(details: SetTitleDetails): Promise<void>
    function setBadgeText(details: SetBadgeTextDetails): Promise<void>
    function setBadgeBackgroundColor(details: SetBadgeBackgroundColorDetails): Promise<void>
  }

  namespace notifications {
    interface CreateNotificationOptions {
      type: 'basic' | 'image' | 'list' | 'progress'
      iconUrl?: string
      title: string
      message: string
    }
    function create(options: CreateNotificationOptions): Promise<string>
    function create(notificationId: string, options: CreateNotificationOptions): Promise<string>
  }
}
