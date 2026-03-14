import { createElement, useCallback, useEffect, useRef, useState } from 'react'
import { ToastAction, type ToastActionElement } from '@/components/ui/toast'
import { toast } from '@/hooks/use-toast'
import { api } from '@/lib/api'
import { buildHumanApprovalReminder, getApprovalReminderKey } from '@/lib/approval-reminders'
import {
  collectHumanApprovalReminderSurfaces,
  collectRecentUnreadSnapshotNotifications,
  resolveMonitorPollInterval,
} from '@/lib/monitor-convergence'
import { normalizeRealtimeMessage, parseRealtimeSessionKey } from '@/lib/realtime-message'
import { gatewayRuntimeFromHealth, mergeGatewayRuntimeStatus, resolveGatewayConnectedFromHealth } from '@/lib/gateway-status'
import { wsClient } from '@/lib/websocket'
import { useAgentStore } from '@/stores/agent-store'
import { useMonitorStore } from '@/stores/monitor-store'
import type {
  AgentStatus,
  ApprovalUpdatePayload,
  GatewayRuntimeStatus,
  LiveFeedSnapshot,
  Notification,
  SessionMessage,
  WorkflowRuntimeSignal,
} from '@/types'

const GATEWAY_MESSAGE_EVENTS = new Set([
  'message',
  'chat.message',
  'agent.message',
  'agent.output',
  'session.message',
])

const GATEWAY_STATUS_EVENTS = new Set(['agent.status', 'agent.update', 'agent.state'])

interface HealthResponse {
  gatewayConnected?: boolean
  gatewayRuntime?: GatewayRuntimeStatus
  gateway?: {
    connected?: boolean
    runtimeRunning?: boolean
    manageable?: boolean
    cliInstalled?: boolean
    host?: string
    port?: number
    gatewayUrl?: string
    error?: string | null
  }
}

function coerceTimestamp(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value > 10_000_000_000 ? value : value * 1000
    return new Date(milliseconds).toISOString()
  }
  return new Date().toISOString()
}

export function useWebSocket() {
  const shownApprovalReminderKeysRef = useRef(new Set<string>())
  const seenSnapshotNotificationIdsRef = useRef(new Set<string>())
  const hasMonitorSnapshotRef = useRef(false)
  const [pageVisible, setPageVisible] = useState(
    () => (typeof document !== 'undefined' ? document.visibilityState !== 'hidden' : true),
  )
  const connected = useMonitorStore((state) => state.connected)
  const {
    setConnected,
    setConnectionReady,
    setGatewayConnected,
    setGatewayRuntime,
    setGatewayLastError,
    setAgentStatus,
    addEvent,
    syncEvents,
    addNotification,
    addRealtimeMessage,
    syncRealtimeMessages,
    setWorkflowSignal,
    syncActiveWorkflowSignals,
    syncScheduledWorkflows,
    syncNotifications,
  } = useMonitorStore()
  const updateAgentStatus = useAgentStore((state) => state.updateAgentStatus)

  const applyAgentStatus = useCallback((agentId: string, status: AgentStatus, timestamp?: string) => {
    setAgentStatus({ agentId, status, timestamp })
    updateAgentStatus(agentId, status)
  }, [setAgentStatus, updateAgentStatus])

  const applyHealthSnapshot = useCallback((health: HealthResponse) => {
    hasMonitorSnapshotRef.current = true
    setConnectionReady(true)
    setGatewayConnected(resolveGatewayConnectedFromHealth(health))
    setGatewayLastError(health.gateway?.error ?? null)
    const nextRuntime = gatewayRuntimeFromHealth(health.gatewayRuntime ?? null)
    setGatewayRuntime(nextRuntime)
  }, [setConnectionReady, setGatewayConnected, setGatewayLastError, setGatewayRuntime])

  const buildApprovalAction = useCallback((workflowUrl: string) => {
    return createElement(
      ToastAction,
      {
        altText: '前往审批',
        onClick: () => window.location.assign(workflowUrl),
      },
      '去审批',
    ) as unknown as ToastActionElement
  }, [])

  const surfaceWorkflowSignalReminder = useCallback((signal: WorkflowRuntimeSignal) => {
    const reminderKey = getApprovalReminderKey(signal)
    if (signal.status !== 'waiting_approval' || signal.approvalMode !== 'human') {
      shownApprovalReminderKeysRef.current.delete(reminderKey)
      return
    }

    if (shownApprovalReminderKeysRef.current.has(reminderKey)) {
      return
    }

    const reminder = buildHumanApprovalReminder(signal)
    if (!reminder) {
      return
    }

    shownApprovalReminderKeysRef.current.add(reminderKey)
    toast({
      title: reminder.title,
      description: reminder.description,
      action: buildApprovalAction(reminder.workflowUrl),
    })
  }, [buildApprovalAction])

  const surfaceApprovalReminderSignals = useCallback((signals: Iterable<WorkflowRuntimeSignal>) => {
    const { reminders, nextShownKeys } = collectHumanApprovalReminderSurfaces(
      signals,
      shownApprovalReminderKeysRef.current,
    )
    shownApprovalReminderKeysRef.current = nextShownKeys

    reminders.forEach(({ reminder }) => {
      toast({
        title: reminder.title,
        description: reminder.description,
        action: buildApprovalAction(reminder.workflowUrl),
      })
    })
  }, [buildApprovalAction])

  const maybeNotifyDesktop = useCallback((notification: Notification) => {
    if (
      typeof document === 'undefined' ||
      document.visibilityState !== 'hidden' ||
      !('Notification' in window) ||
      Notification.permission !== 'granted'
    ) {
      return
    }

    new Notification(notification.title, {
      body: notification.message,
      icon: '/favicon.ico',
      tag: notification.id,
    })
  }, [])

  const surfaceSnapshotNotifications = useCallback((notifications: Notification[]) => {
    const { notifications: surfaced, nextSeenIds } = collectRecentUnreadSnapshotNotifications(
      notifications,
      seenSnapshotNotificationIdsRef.current,
    )
    seenSnapshotNotificationIdsRef.current = nextSeenIds

    surfaced.forEach((notification) => {
      toast({
        title: notification.title,
        description: notification.message,
        variant: notification.type === 'workflow_error' ? 'destructive' : undefined,
      })
      maybeNotifyDesktop(notification)
    })
  }, [maybeNotifyDesktop])

  const applyLiveFeedSnapshot = useCallback((snapshot: LiveFeedSnapshot) => {
    hasMonitorSnapshotRef.current = true
    setConnectionReady(true)
    syncEvents(snapshot.events ?? [])
    syncRealtimeMessages(snapshot.messages ?? [])
    syncActiveWorkflowSignals(snapshot.workflowSignals ?? [])
    syncScheduledWorkflows(snapshot.scheduledWorkflows ?? [])
    syncNotifications(snapshot.notifications ?? [], snapshot.unreadCount ?? 0)
    surfaceApprovalReminderSignals(snapshot.workflowSignals ?? [])
    surfaceSnapshotNotifications(snapshot.notifications ?? [])
  }, [
    surfaceApprovalReminderSignals,
    surfaceSnapshotNotifications,
    syncActiveWorkflowSignals,
    syncEvents,
    syncNotifications,
    syncRealtimeMessages,
    syncScheduledWorkflows,
  ])

  useEffect(() => {
    if (typeof document === 'undefined') {
      return
    }
    const handleVisibilityChange = () => {
      setPageVisible(document.visibilityState !== 'hidden')
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  useEffect(() => {
    const handleGatewayRealtimeEvent = (raw: unknown) => {
      if (!raw || typeof raw !== 'object') {
        return
      }

      const record = raw as { event?: string; data?: unknown; payload?: unknown; timestamp?: unknown }
      const eventName =
        typeof record.event === 'string'
          ? record.event
          : typeof (record as Record<string, unknown>).type === 'string'
            ? ((record as Record<string, unknown>).type as string)
            : ''
      const data = record.data ?? record.payload ?? record

      if (GATEWAY_MESSAGE_EVENTS.has(eventName) || (!eventName && data)) {
        const normalized = normalizeRealtimeMessage(data)
        if (normalized) {
          addRealtimeMessage(normalized)
        }
      }

      if (GATEWAY_STATUS_EVENTS.has(eventName) && data && typeof data === 'object') {
        const eventData = data as Record<string, unknown>
        const status = eventData.status as AgentStatus | undefined
        const explicitAgent = eventData.agentId as string | undefined
        const parsed = typeof eventData.sessionKey === 'string' ? parseRealtimeSessionKey(eventData.sessionKey) : {}
        const agentId = explicitAgent || parsed.agentId
        if (agentId && typeof status === 'string') {
          const timestamp = coerceTimestamp(eventData.timestamp ?? record.timestamp)
          applyAgentStatus(agentId, status, timestamp)
        }
      }
    }

    const unsubConnection = wsClient.onConnectionChange((isConnected) => {
      setConnected(isConnected)
      if (!isConnected) {
        if (hasMonitorSnapshotRef.current) {
          setConnectionReady(true)
        }
        setGatewayConnected(false)
        return
      }

      void Promise.all([
        api.get<HealthResponse>('/health').then(applyHealthSnapshot),
        api.get<LiveFeedSnapshot>('/monitor/live-feed-snapshot?limit=50').then(applyLiveFeedSnapshot),
      ]).catch(() => {})
    })
    wsClient.connect()

    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission()
    }

    const unsubStatus = wsClient.on('agent_status', (data) => {
      const event = data as { agentId?: string; status?: AgentStatus; timestamp?: string }
      if (!event.agentId || !event.status) return
      applyAgentStatus(event.agentId, event.status, event.timestamp)
    })

    const unsubComm = wsClient.on('communication', (raw) => {
      addEvent(raw as any)
    })

    const unsubMessage = wsClient.on('new_message', (data) => {
      const normalized = normalizeRealtimeMessage(data)
      if (normalized) {
        addRealtimeMessage(normalized)
      }
    })

    const unsubGateway = wsClient.on('gateway_status', (data) => {
      const payload = (data ?? {}) as {
        connected?: boolean
        runtimeRunning?: boolean
        manageable?: boolean
        cliInstalled?: boolean
        host?: string
        port?: number
        gatewayUrl?: string
        error?: string | null
      }
      setGatewayConnected(Boolean(payload.connected))
      setGatewayLastError(payload.error ?? null)
      const current = useMonitorStore.getState().gatewayRuntime
      const nextRuntime = mergeGatewayRuntimeStatus(current, payload)
      if (nextRuntime !== current) {
        setGatewayRuntime(nextRuntime)
      }
    })

    const unsubGatewayEvent = wsClient.on('gateway_event', (data) => {
      handleGatewayRealtimeEvent(data)
    })

    const unsubGatewayChat = wsClient.on('gateway_chat', (data) => {
      handleGatewayRealtimeEvent({ event: 'chat.message', data })
    })

    const unsubWorkflow = wsClient.on('workflow_update', (data) => {
      const signal = data as WorkflowRuntimeSignal
      if (!signal?.executionId) {
        return
      }
      const nextSignal: WorkflowRuntimeSignal = {
        ...signal,
        updatedAt: signal.updatedAt ?? new Date().toISOString(),
      }
      setWorkflowSignal(nextSignal)
      surfaceWorkflowSignalReminder(nextSignal)
    })

    const unsubNotification = wsClient.on('notification', (data) => {
      const notification = data as Notification
      addNotification(notification)
      surfaceSnapshotNotifications([notification])
    })

    const unsubApproval = wsClient.on('approval_update', (data) => {
      const approval = data as ApprovalUpdatePayload
      const reminderKey = approval?.id || `${approval?.executionId || 'unknown'}:${approval?.nodeId || '__approval__'}`
      shownApprovalReminderKeysRef.current.delete(reminderKey)
      if (approval.status === 'approved' || approval.status === 'rejected') {
        addNotification({
          id: `approval-${approval.id}-${Date.now()}`,
          type: approval.status === 'approved' ? 'workflow_completed' : 'workflow_error',
          title: approval.status === 'approved' ? '审批已通过' : '审批已驳回',
          message: approval.rejectReason || (approval.status === 'approved' ? '工作流将继续执行' : '工作流已终止'),
          executionId: approval.executionId,
          nodeId: approval.nodeId ?? undefined,
          read: false,
          createdAt: new Date().toISOString(),
        })
      }
    })

    return () => {
      shownApprovalReminderKeysRef.current.clear()
      seenSnapshotNotificationIdsRef.current.clear()
      hasMonitorSnapshotRef.current = false
      unsubStatus()
      unsubComm()
      unsubMessage()
      unsubGatewayEvent()
      unsubGatewayChat()
      unsubGateway()
      unsubWorkflow()
      unsubNotification()
      unsubApproval()
      const didDisconnect = wsClient.disconnect()
      if (didDisconnect) {
        setConnected(false)
      }
      unsubConnection()
    }
  }, [
    addEvent,
    addNotification,
    addRealtimeMessage,
    applyAgentStatus,
    applyHealthSnapshot,
    applyLiveFeedSnapshot,
    setConnected,
    setConnectionReady,
    setGatewayConnected,
    setGatewayLastError,
    setGatewayRuntime,
    setWorkflowSignal,
    surfaceSnapshotNotifications,
    surfaceWorkflowSignalReminder,
  ])

  useEffect(() => {
    let disposed = false

    const createPoller = (
      kind: 'health' | 'statuses' | 'liveFeed',
      task: () => Promise<void>,
    ) => {
      let timer: number | null = null
      let inFlight = false
      let consecutiveFailures = 0

      const schedule = () => {
        if (disposed) {
          return
        }
        const delay = resolveMonitorPollInterval({
          kind,
          visible: pageVisible,
          connected,
          consecutiveFailures,
        })
        timer = window.setTimeout(() => {
          void run()
        }, delay)
      }

      const run = async () => {
        if (disposed || inFlight) {
          schedule()
          return
        }

        inFlight = true
        try {
          await task()
          consecutiveFailures = 0
        } catch {
          if (!disposed) {
            consecutiveFailures += 1
          }
        } finally {
          inFlight = false
          schedule()
        }
      }

      void run()

      return () => {
        if (timer !== null) {
          window.clearTimeout(timer)
        }
      }
    }

    const stopHealth = createPoller('health', async () => {
      const health = await api.get<HealthResponse>('/health')
      if (disposed) {
        return
      }
      applyHealthSnapshot(health)
    })

    const stopStatuses = createPoller('statuses', async () => {
      const statuses = await api.get<Record<string, AgentStatus>>('/monitor/statuses')
      if (disposed) {
        return
      }
      const timestamp = new Date().toISOString()
      Object.entries(statuses || {}).forEach(([agentId, status]) => {
        applyAgentStatus(agentId, status, timestamp)
      })
    })

    const stopLiveFeed = createPoller('liveFeed', async () => {
      const snapshot = await api.get<LiveFeedSnapshot>('/monitor/live-feed-snapshot?limit=50')
      if (disposed) {
        return
      }
      applyLiveFeedSnapshot(snapshot)
    })

    return () => {
      disposed = true
      stopHealth()
      stopStatuses()
      stopLiveFeed()
    }
  }, [applyAgentStatus, applyHealthSnapshot, applyLiveFeedSnapshot, connected, pageVisible])
}
