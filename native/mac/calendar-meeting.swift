// calendar-meeting.swift — the macOS counterpart of native/outlook-meeting.cs: pull the current
// meeting's details from macOS Calendar through EventKit and print them as one JSON line.
//
// Why EventKit and not Outlook for Mac: the new Outlook (the only one Microsoft ships since 2024)
// exposes no calendar to other apps — its AppleScript dictionary answers with one empty "Calendar",
// zero events, and no accounts (verified on Outlook 16.112). macOS Calendar sees every account the
// user adds under System Settings → Internet Accounts (Exchange / Microsoft 365, Google, iCloud),
// with attendees, organizer, response state, and notes, and it needs no token or app registration.
//
// Modes and JSON are the exe's, so app/main.js drives both binaries with the same code:
//   calendar-meeting check
//       -> {"ok":true,"accounts":[{"name":"<account as macOS Calendar names it>","calendars":["Calendar",...]},...]}
//   calendar-meeting meeting "<account>" "<calendar>" "<skipPrefix1,skipPrefix2,...>"
//       -> {"subject","start","end","organizer","required_attendees","optional_attendees","response_status",
//           "location","body","categories","importance","is_recurring","meeting_status","online_meeting_url"}
//          or {"ok":false,"none":true} when nothing on the calendar matches "now".
//   Any failure: {"ok":false,"error":"..."} on stdout, exit 0 (the caller reads the JSON, not the code).
//
// Selection is the exe's recipe, unchanged: if the next :00/:30 boundary is less than 5 minutes
// away, the meeting starting at that boundary wins; otherwise the meeting containing now (latest
// start wins); all-day events and subjects starting with a skip prefix never count.
//
// Permission: Calendars (Full Access). The first request shows the macOS prompt for the app that
// launched us (Bedrock Panel, or Terminal for `npm start`); that app's Info.plist must carry
// NSCalendarsFullAccessUsageDescription or TCC kills the caller instead of asking — the string is
// in package.json's extendInfo and in calendar-meeting.plist (embedded as our own __info_plist).
// A denied/never-answered prompt is reported as a readable error, never a hang.

import Foundation
import EventKit

@main struct CalendarMeeting {
    struct Account { let name: String; let source: EKSource; let calendars: [EKCalendar] }

    static let deniedMessage = "Calendar access is off for this app. System Settings → Privacy & Security → Calendars → " +
        "turn on Bedrock Panel (Full Access; Terminal when running from source), then click Check Connection again."
    static let noAccountsMessage = "No calendar accounts in macOS Calendar. Outlook for Mac keeps its calendar to itself: add the same " +
        "account under System Settings → Internet Accounts with Calendars turned on, or choose the Microsoft 365 calendar source."

    static func fail(_ msg: String) -> Never { Out.line(Out.json(["ok": false, "error": msg])); exit(0) }

    static func main() {
        Out.setup()
        let argv = Array(CommandLine.arguments.dropFirst())
        let mode = argv.first ?? ""
        if mode == "selftest" { selftest() }   // pure-logic checks for the test suite; never touches the store
        if mode != "check" && mode != "meeting" {
            fail(mode.isEmpty ? "usage: calendar-meeting check | meeting <account> <calendar> [skipPrefixes]" : "unknown mode: \(mode)")
        }
        if mode == "meeting" && argv.count < 3 { fail("usage: calendar-meeting meeting <account> <calendar> [skipPrefixes]") }
        // Work off the main thread; the main run loop serves TCC's reply to the access request.
        DispatchQueue.global(qos: .userInitiated).async {
            let store = EKEventStore()
            ensureAccess(store)
            if mode == "check" { check(store) } else { meeting(store, account: argv[1], calendar: argv[2], skip: argv.count > 3 ? argv[3] : "") }
            exit(0)
        }
        RunLoop.main.run()
    }

    // ---- access ----
    static func ensureAccess(_ store: EKEventStore) {
        let status = EKEventStore.authorizationStatus(for: .event)
        switch status {
        case .fullAccess: return
        case .notDetermined:
            let done = DispatchSemaphore(value: 0)
            var granted = false
            store.requestFullAccessToEvents { ok, _ in granted = ok; done.signal() }
            // Longer than any caller's timeout: the prompt is the user's to answer, the caller's to give up on.
            if done.wait(timeout: .now() + 600) == .timedOut { fail("The Calendar access prompt was not answered.") }
            // No prompt and no grant: the app that launched us declares no calendar usage string (macOS
            // then denies silently) or the prompt was declined. Bedrock Panel declares it; a bare host may not.
            if !granted { fail(deniedMessage + " (no grant: the prompt was declined, or the app that launched this helper declares no NSCalendarsFullAccessUsageDescription)") }
        default: fail(deniedMessage + " (status: \(statusWord(status)))")   // denied, restricted, write-only: none lets us read events
        }
    }
    static func statusWord(_ s: EKAuthorizationStatus) -> String {
        switch s {
        case .fullAccess: return "fullAccess"
        case .writeOnly: return "writeOnly"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        default: return "unknown(\(s.rawValue))"
        }
    }

    // ---- accounts = EventKit sources, calendars grouped under them ----
    static func accounts(_ store: EKEventStore) -> [Account] {
        var groups: [String: (EKSource, [EKCalendar])] = [:]
        var order: [String] = []
        for c in store.calendars(for: .event) {
            guard let s = c.source else { continue }
            if groups[s.sourceIdentifier] == nil { groups[s.sourceIdentifier] = (s, []); order.append(s.sourceIdentifier) }
            groups[s.sourceIdentifier]!.1.append(c)
        }
        // The default calendar's account first, the rest by name; calendars by name.
        let defaultSource = store.defaultCalendarForNewEvents?.source?.sourceIdentifier
        let sorted = order.map { groups[$0]! }.sorted { a, b in
            if a.0.sourceIdentifier == defaultSource { return true }
            if b.0.sourceIdentifier == defaultSource { return false }
            return a.0.title.localizedCaseInsensitiveCompare(b.0.title) == .orderedAscending
        }
        // Two accounts with the same title (two Google accounts) get numbered, identically in both modes.
        var seen: [String: Int] = [:]
        return sorted.map { src, cals in
            let base = src.title.isEmpty ? "Calendar account" : src.title
            let n = (seen[base.lowercased()] ?? 0) + 1
            seen[base.lowercased()] = n
            return Account(name: n == 1 ? base : "\(base) (\(n))", source: src,
                           calendars: cals.sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending })
        }
    }

    static func check(_ store: EKEventStore) {
        let list = accounts(store)
        if list.isEmpty { fail(noAccountsMessage) }
        Out.line(Out.json(["ok": true, "accounts": list.map { ["name": $0.name, "calendars": $0.calendars.map { $0.title }] }]))
    }

    // ---- the meeting for "now" ----
    static func meeting(_ store: EKEventStore, account: String, calendar calName: String, skip: String) {
        let list = accounts(store)
        if list.isEmpty { fail(noAccountsMessage) }
        guard let acct = list.first(where: { $0.name.caseInsensitiveCompare(account) == .orderedSame }) else {
            fail("Account \"\(account)\" not found in macOS Calendar (have: \(list.map { $0.name }.joined(separator: ", "))). Click Check Connection and pick one.")
        }
        // Exact (case-insensitive) calendar name, or the account's only calendar — a Google account's
        // one calendar is named after the address, not "Calendar".
        guard let cal = acct.calendars.first(where: { $0.title.caseInsensitiveCompare(calName) == .orderedSame })
                ?? (acct.calendars.count == 1 ? acct.calendars[0] : nil) else {
            fail("Calendar \"\(calName)\" not found under account \"\(account)\" (has: \(acct.calendars.map { $0.title }.joined(separator: ", "))).")
        }
        let prefixes = skip.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }

        let now = Date()
        let local = Calendar.current
        let dayStart = local.startOfDay(for: now)
        let dayEnd = local.date(byAdding: .day, value: 1, to: dayStart) ?? now.addingTimeInterval(86400)
        // predicateForEvents expands recurrences into occurrences, like IncludeRecurrences + Restrict.
        let todays = store.events(matching: store.predicateForEvents(withStart: dayStart, end: dayEnd, calendars: [cal]))
            .filter { ev in
                if ev.isAllDay { return false }
                guard let st = ev.startDate, ev.endDate != nil, local.isDate(st, inSameDayAs: now) else { return false }
                let subject = ev.title ?? ""
                return !prefixes.contains { subject.lowercased().hasPrefix($0.lowercased()) }
            }
            .sorted { $0.startDate < $1.startDate }

        guard let idx = pickIndex(now: now, spans: todays.map { (start: $0.startDate, end: $0.endDate) }, calendar: local) else {
            Out.line(Out.json(["ok": false, "none": true])); return
        }
        let ev = todays[idx]

        var required: [String] = [], optional: [String] = []
        for p in ev.attendees ?? [] {
            if p.participantType == .room || p.participantType == .resource { continue }   // rooms live in "location"
            let name = normalizeName(participantName(p))
            if name.isEmpty { continue }
            if p.participantRole == .optional || p.participantRole == .nonParticipant { optional.append(name) } else { required.append(name) }
        }
        let subject = (ev.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let organizerIsMe = ev.organizer?.isCurrentUser ?? false
        var info: [String: Any] = [
            "subject": subject.isEmpty ? "Untitled Meeting" : subject,
            "start": utc(ev.startDate), "end": utc(ev.endDate),
            "organizer": normalizeName(ev.organizer.map(participantName) ?? ""),
            "required_attendees": required, "optional_attendees": optional,
            "response_status": responseStatus(ev, organizerIsMe: organizerIsMe),
            "location": ev.location ?? "",
            "body": ev.notes ?? "",
            "categories": [String](),                  // EventKit has no categories
            "importance": "Normal",                     // nor an importance flag
            "is_recurring": ev.hasRecurrenceRules || ev.isDetached,
            "meeting_status": ev.status == .canceled ? "MeetingCanceled" : (ev.hasAttendees ? (organizerIsMe ? "Meeting" : "MeetingReceived") : "NonMeeting"),
        ]
        info["online_meeting_url"] = meetingLink(ev) ?? NSNull()
        Out.line(Out.json(info))
    }

    // ---- the exe's selection rule over (start, end) spans sorted by start: the winner's index, nil for none ----
    // Selection: <5 min before the next :00/:30 boundary -> the meeting starting at that boundary;
    // otherwise the meeting containing now (latest start wins). Nothing matching -> none.
    static func pickIndex(now: Date, spans: [(start: Date, end: Date)], calendar local: Calendar) -> Int? {
        let minute = local.component(.minute, from: now)
        let hourStart = local.date(bySettingHour: local.component(.hour, from: now), minute: 0, second: 0, of: now) ?? now
        let boundary = hourStart.addingTimeInterval(minute < 30 ? 30 * 60 : 60 * 60)
        if boundary.timeIntervalSince(now) < 5 * 60, let i = spans.firstIndex(where: { abs($0.start.timeIntervalSince(boundary)) <= 60 }) { return i }
        var chosen: Int? = nil
        for (i, s) in spans.enumerated() where s.start <= now && now < s.end { chosen = i }
        return chosen
    }

    // ---- field helpers (the exe's rules) ----
    static func utc(_ d: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(secondsFromGMT: 0)
        f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss'+00:00'"
        return f.string(from: d)
    }
    /// "Last, First" -> "First Last", matching the Graph source and the exe.
    static func normalizeName(_ value: String) -> String {
        var name = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if let comma = name.firstIndex(of: ",") {
            let last = name[..<comma].trimmingCharacters(in: .whitespaces)
            let first = name[name.index(after: comma)...].trimmingCharacters(in: .whitespaces)
            name = (first + " " + last).trimmingCharacters(in: .whitespaces)
        }
        return name
    }
    static func participantName(_ p: EKParticipant) -> String {
        if let n = p.name, !n.trimmingCharacters(in: .whitespaces).isEmpty { return n }
        let u = p.url.absoluteString
        return u.lowercased().hasPrefix("mailto:") ? String(u.dropFirst("mailto:".count)) : u
    }
    static func responseStatus(_ ev: EKEvent, organizerIsMe: Bool) -> String {
        if organizerIsMe { return "Organizer" }
        guard let me = ev.attendees?.first(where: { $0.isCurrentUser }) else { return "None" }
        switch me.participantStatus {
        case .accepted: return "Accepted"
        case .declined: return "Declined"
        case .tentative: return "Tentative"
        case .pending: return "NotResponded"
        default: return "None"
        }
    }
    /// The join link: a known provider's URL anywhere in the URL field, location, or notes (Exchange puts
    /// the Teams link in the body), else the event's URL field, else null — the exe's OnlineMeetingURL.
    static func meetingLink(_ ev: EKEvent) -> String? {
        let hay = [ev.url?.absoluteString, ev.location, ev.notes].compactMap { $0 }.joined(separator: "\n")
        if let link = findLink(in: hay) { return link }
        if let u = ev.url?.absoluteString, !u.isEmpty { return u }
        return nil
    }
    static func findLink(in hay: String) -> String? {
        let providers = [
            "https://teams\\.microsoft\\.com/l/meetup-join/[^\\s<>\"']+",
            "https://teams\\.live\\.com/meet/[^\\s<>\"']+",
            "https://[\\w.-]*zoom\\.us/[jw]/[^\\s<>\"']+",
            "https://meet\\.google\\.com/[^\\s<>\"']+",
            "https://[\\w.-]*webex\\.com/[^\\s<>\"']+",
        ]
        for p in providers {
            if let r = hay.range(of: p, options: [.regularExpression, .caseInsensitive]) { return String(hay[r]) }
        }
        return nil
    }

    // ---- `selftest`: the pure rules above against fixed cases; {"ok":true,"selftest":N} or the failures ----
    static func selftest() -> Never {
        let local = Calendar.current
        func at(_ h: Int, _ m: Int) -> Date { local.date(bySettingHour: h, minute: m, second: 0, of: Date())! }
        var failures: [String] = []
        var count = 0
        func expect(_ cond: Bool, _ what: String) { count += 1; if !cond { failures.append(what) } }
        let spans = [(start: at(9, 30), end: at(10, 30)), (start: at(10, 0), end: at(11, 0))]
        expect(pickIndex(now: at(9, 56), spans: spans, calendar: local) == 1, "within 5 min of :00 the meeting starting then wins")
        expect(pickIndex(now: at(9, 50), spans: spans, calendar: local) == 0, "otherwise the meeting containing now")
        expect(pickIndex(now: at(10, 15), spans: spans, calendar: local) == 1, "two containing now: the latest start")
        expect(pickIndex(now: at(10, 26), spans: spans, calendar: local) == 1, "near :30 with nothing starting then: the containing meeting")
        expect(pickIndex(now: at(12, 0), spans: spans, calendar: local) == nil, "nothing containing now: none")
        expect(pickIndex(now: at(9, 56), spans: [], calendar: local) == nil, "no meetings: none")
        expect(normalizeName("Schmitz, T.J.") == "T.J. Schmitz", "Last, First -> First Last")
        expect(normalizeName("  Ada Lovelace ") == "Ada Lovelace", "names are trimmed")
        expect(findLink(in: "Join: <https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%7d> ok") == "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%7d", "Teams link out of the body")
        expect(findLink(in: "https://us02web.zoom.us/j/123456?pwd=x\nagenda") == "https://us02web.zoom.us/j/123456?pwd=x", "Zoom link")
        expect(findLink(in: "no links here") == nil, "no link -> nil")
        expect(utc(Date(timeIntervalSince1970: 0)) == "1970-01-01T00:00:00+00:00", "UTC in the exe's format")
        if failures.isEmpty { Out.line(Out.json(["ok": true, "selftest": count])); exit(0) }
        Out.line(Out.json(["ok": false, "error": failures.joined(separator: "; ")])); exit(1)
    }
}
