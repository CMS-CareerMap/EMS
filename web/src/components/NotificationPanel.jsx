import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Bell,
  CheckCheck,
  Trash2,
  Calendar,
  Clock,
  Megaphone,
  CheckSquare,
  ShieldCheck,
  User,
  UserPlus,
  DollarSign,
  Info,
  ChevronRight,
  Sparkles,
  X,
  FileText,
  Landmark,
} from 'lucide-react'
import {
  useNotifications,
  useMarkNotificationAsRead,
  useMarkAllNotificationsAsRead,
  useClearAllNotifications
} from '../hooks/useNotifications'

function formatTimeAgo(dateString) {
  if (!dateString) return ''
  const date = new Date(dateString)
  const now = new Date()
  const seconds = Math.floor((now - date) / 1000)

  if (seconds < 30) return 'Just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

function getNotificationIcon(type) {
  switch (type) {
    case 'leave':
      return { icon: Calendar, bg: 'bg-purple-100 text-purple-600' }
    case 'attendance':
      return { icon: Clock, bg: 'bg-emerald-100 text-emerald-600' }
    case 'announcement':
      return { icon: Megaphone, bg: 'bg-amber-100 text-amber-600' }
    case 'task':
      return { icon: CheckSquare, bg: 'bg-blue-100 text-blue-600' }
    case 'auth':
      return { icon: ShieldCheck, bg: 'bg-indigo-100 text-indigo-600' }
    case 'profile':
      return { icon: User, bg: 'bg-sky-100 text-sky-600' }
    case 'employee':
      return { icon: UserPlus, bg: 'bg-violet-100 text-violet-600' }
    case 'payroll':
      return { icon: DollarSign, bg: 'bg-teal-100 text-teal-600' }
    case 'document':
      return { icon: FileText, bg: 'bg-blue-100 text-blue-600' }
    case 'bank':
      return { icon: Landmark, bg: 'bg-teal-100 text-teal-700' }
    case 'account':
      return { icon: ShieldCheck, bg: 'bg-indigo-100 text-indigo-600' }
    case 'system':
    default:
      return { icon: Info, bg: 'bg-slate-100 text-slate-600' }
  }
}

export default function NotificationPanel({ isOpen, onClose }) {
  const navigate = useNavigate()
  const panelRef = useRef(null)

  const { notifications, unreadCount, isLoading, hasOlder, loadingOlder, loadOlder } = useNotifications()
  const markAsReadMutation = useMarkNotificationAsRead()
  const markAllMutation = useMarkAllNotificationsAsRead()
  const clearAllMutation = useClearAllNotifications()

  const [activeTab, setActiveTab] = useState('all') // 'all' | 'unread'
  const [displayLimit, setDisplayLimit] = useState(10)

  // Handle click outside & ESC key
  useEffect(() => {
    const handleClickOutside = (e) => {
      // The bell toggles the panel itself; closing here too would let its
      // click open it straight back up.
      if (e.target.closest?.('[data-notification-toggle]')) return
      if (panelRef.current && !panelRef.current.contains(e.target)) {
        onClose()
      }
    }
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && isOpen) {
        onClose()
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      document.addEventListener('keydown', handleKeyDown)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, onClose])

  if (!isOpen) return null

  const filteredNotifications = notifications.filter((item) => {
    if (activeTab === 'unread') return !item.read
    return true
  })

  const visibleNotifications = filteredNotifications.slice(0, displayLimit)
  // More already here to show, or more on the server to fetch.
  const hasMore = filteredNotifications.length > displayLimit || hasOlder

  const showOlder = async () => {
    if (filteredNotifications.length <= displayLimit && hasOlder) await loadOlder()
    setDisplayLimit((prev) => prev + 10)
  }

  const handleNotificationClick = async (item) => {
    if (!item.read) {
      markAsReadMutation.mutate({ id: item.id })
    }
    if (item.link) {
      navigate(item.link)
    }
    onClose()
  }

  const handleMarkAllRead = () => {
    if (unreadCount > 0) markAllMutation.mutate()
  }

  const handleClearAll = () => {
    if (notifications.length > 0) clearAllMutation.mutate()
  }

  return (
    <div
      ref={panelRef}
      // A phone gets the screen's width under the header; from sm up it hangs from the bell.
      className="fixed left-2 right-2 top-16 sm:absolute sm:left-auto sm:right-0 sm:top-full sm:mt-2 sm:w-96 bg-white rounded-2xl border border-gray-200 shadow-2xl z-50 overflow-hidden transition-all duration-200 ease-out transform scale-100 opacity-100"
    >
      {/* Panel Header */}
      <div className="p-4 border-b border-gray-100 bg-slate-50/70 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Bell className="w-5 h-5 text-gray-700" />
          <h2 className="font-semibold text-gray-900 text-base">Notifications</h2>
          {unreadCount > 0 && (
            <span className="px-2 py-0.5 text-xs font-bold text-white bg-red-500 rounded-full animate-pulse">
              {unreadCount}
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-200/50 transition-colors"
          title="Close panel"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Tabs & Quick Actions */}
      <div className="px-4 py-2 border-b border-gray-100 bg-white flex items-center justify-between text-xs">
        <div className="flex items-center gap-1 bg-gray-100 p-1 rounded-lg">
          <button
            onClick={() => setActiveTab('all')}
            className={`px-3 py-1 rounded-md font-medium transition-colors ${activeTab === 'all'
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-800'
              }`}
          >
            All ({notifications.length}{hasOlder ? '+' : ''})
          </button>
          <button
            onClick={() => setActiveTab('unread')}
            className={`px-3 py-1 rounded-md font-medium transition-colors ${activeTab === 'unread'
                ? 'bg-white text-blue-600 shadow-sm'
                : 'text-gray-500 hover:text-gray-800'
              }`}
          >
            Unread ({unreadCount})
          </button>
        </div>

        <div className="flex items-center gap-2">
          {unreadCount > 0 && (
            <button
              onClick={handleMarkAllRead}
              className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 font-medium transition-colors"
              title="Mark all as read"
            >
              <CheckCheck className="w-3.5 h-3.5" />
              <span>Mark all read</span>
            </button>
          )}
          {notifications.length > 0 && (
            <button
              onClick={handleClearAll}
              className="flex items-center gap-1 text-xs text-gray-400 hover:text-red-600 font-medium transition-colors"
              title="Clear all notifications"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Clear</span>
            </button>
          )}
        </div>
      </div>

      {/* Notification List Container */}
      <div className="max-h-96 overflow-y-auto divide-y divide-gray-100">
        {isLoading ? (
          <div className="p-8 text-center text-gray-400 text-sm">Loading notifications…</div>
        ) : visibleNotifications.length === 0 ? (
          <div className="p-10 text-center flex flex-col items-center gap-2">
            <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center text-slate-400">
              <Sparkles className="w-6 h-6" />
            </div>
            <p className="text-sm font-medium text-gray-700">No notifications</p>
            <p className="text-xs text-gray-400">
              {activeTab === 'unread' ? 'You have read all your notifications!' : 'No new notifications to display.'}
            </p>
          </div>
        ) : (
          visibleNotifications.map((item) => {
            const { icon: Icon, bg } = getNotificationIcon(item.type)
            return (
              <div
                key={item.id}
                role="button"
                tabIndex={0}
                onClick={() => handleNotificationClick(item)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    handleNotificationClick(item)
                  }
                }}
                className={`p-3.5 flex items-start gap-3 hover:bg-gray-50 transition-colors cursor-pointer relative group ${!item.read ? 'bg-blue-50/40 font-normal' : 'bg-white'
                  }`}
              >
                {/* Type Icon */}
                <div className={`p-2 rounded-xl ${bg} shrink-0 mt-0.5`}>
                  <Icon className="w-4 h-4" />
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-1">
                    <p className={`text-xs font-semibold truncate ${!item.read ? 'text-gray-900' : 'text-gray-700'}`}>
                      {item.title || 'Notification'}
                    </p>
                    <span className="text-[10px] text-gray-400 shrink-0">
                      {formatTimeAgo(item.created_at)}
                    </span>
                  </div>
                  <p className="text-xs text-gray-600 mt-0.5 line-clamp-2 leading-relaxed">
                    {item.message}
                  </p>
                </div>

                {/* Unread Indicator & Arrow */}
                <div className="flex items-center gap-1.5 self-center shrink-0">
                  {!item.read && (
                    <span className="w-2 h-2 rounded-full bg-blue-600" title="Unread" />
                  )}
                  <ChevronRight className="w-4 h-4 text-gray-300 group-hover:text-gray-500 transition-colors" />
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* Footer / Load More */}
      {hasMore && (
        <div className="p-2 border-t border-gray-100 bg-gray-50 text-center">
          <button
            onClick={showOlder}
            disabled={loadingOlder}
            className="text-xs font-medium text-blue-600 hover:text-blue-700 transition-colors py-1 disabled:opacity-60"
          >
            {loadingOlder ? 'Loading…' : 'Load older notifications'}
          </button>
        </div>
      )}
    </div>
  )
}
