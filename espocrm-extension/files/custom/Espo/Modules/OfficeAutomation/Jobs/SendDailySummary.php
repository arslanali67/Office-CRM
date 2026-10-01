<?php

namespace Espo\Modules\OfficeAutomation\Jobs;

use DateTime;
use DateTimeZone;
use Espo\Core\Job\JobDataLess;
use Espo\Core\Utils\Config;
use Espo\ORM\EntityManager;
use Espo\Tools\Email\SendService;

/** Mails the owner(s) yesterday's numbers (from the DailyReport written by the automation service). */
class SendDailySummary implements JobDataLess
{
    public function __construct(
        private EntityManager $entityManager,
        private Config $config,
        private SendService $sendService
    ) {}

    public function run(): void
    {
        $tz = new DateTimeZone($this->config->get('timeZone') ?: 'UTC');
        $date = (new DateTime('yesterday', $tz))->format('Y-m-d');

        $report = $this->entityManager->getRDBRepository('DailyReport')->where(['date' => $date])->findOne();
        $account = $this->entityManager->getRDBRepository('InboundEmail')
            ->where(['status' => 'Active', 'useSmtp' => true])->findOne();

        if (!$account) {
            return;
        }

        $body = $report ? $this->format($report, $date) : "No report was produced for $date (the automation service may be down).";

        $owners = $this->entityManager->getRDBRepository('User')->where(['type' => 'admin', 'isActive' => true])->find();
        foreach ($owners as $owner) {
            if (!$owner->get('emailAddress')) {
                continue;
            }

            $email = $this->entityManager->createEntity('Email', [
                'name' => "Daily summary $date",
                'body' => $body,
                'isHtml' => false,
                'status' => 'Sending',
                'from' => $account->get('emailAddress'),
                'to' => $owner->get('emailAddress'),
            ]);
            $this->sendService->send($email, null);
        }
    }

    private function format($r, string $date): string
    {
        $n = fn (string $f) => $r->get($f) ?? 0;
        $lines = [
            "Daily summary for $date",
            '',
            'TASKS',
            sprintf('  Open: %d, overdue: %d (%.1f%%)', $n('tasksOpen'), $n('tasksOverdue'), $n('overdueRate')),
            sprintf('  Completed: %d, on time: %d (%.1f%%)', $n('tasksCompleted'), $n('tasksCompletedOnTime'), $n('onTimeRate')),
            '',
            'ATTENDANCE',
            sprintf('  Hours worked: %.1f, late arrivals: %d', $n('attendanceHours'), $n('lateArrivals')),
            '',
            'MESSAGES',
            sprintf('  Emails: %d, Facebook DMs: %d, Instagram DMs: %d', $n('emailsIn'), $n('facebookIn'), $n('instagramIn')),
            sprintf('  Average first response: %.1f min', $n('avgResponseMinutes')),
            sprintf('  AI answered on its own: %d of %d (%.1f%%)', $n('aiAutoReplied'), $n('aiHandled'), $n('aiAutomationRate')),
            sprintf('  AI drafts sent by a person: %d, of which edited: %d (%.1f%%)', $n('draftsUsed'), $n('draftsEdited'), $n('editedDraftRate')),
            '',
            'CAMPAIGNS (all time)',
            sprintf('  Sent: %d, opened: %d, bounced: %d, opted out: %d', $n('campaignSent'), $n('campaignOpened'), $n('campaignBounced'), $n('campaignOptedOut')),
        ];

        return implode("\n", $lines);
    }
}
