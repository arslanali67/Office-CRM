<?php

namespace Espo\Modules\OfficeAutomation\Jobs;

use DateTime;
use DateTimeZone;
use Espo\Core\Job\JobDataLess;
use Espo\Core\Utils\Config;
use Espo\ORM\EntityManager;

/**
 * Closes shifts forgotten from a previous day at 23:59:59 of that day (office time zone)
 * and flags them autoClosed so the owner can review.
 */
class AutoCloseAttendance implements JobDataLess
{
    public function __construct(private EntityManager $entityManager, private Config $config) {}

    public function run(): void
    {
        $utc = new DateTimeZone('UTC');
        $tz = new DateTimeZone($this->config->get('timeZone') ?: 'UTC');
        $todayStart = (new DateTime('today', $tz))->setTimezone($utc)->format('Y-m-d H:i:s');

        $open = $this->entityManager->getRDBRepository('Attendance')
            ->where(['checkOut' => null, 'checkIn<' => $todayStart])->find();

        foreach ($open as $shift) {
            $end = (new DateTime($shift->get('checkIn'), $utc))->setTimezone($tz)->setTime(23, 59, 59);
            $shift->set('checkOut', $end->setTimezone($utc)->format('Y-m-d H:i:s'));
            $shift->set('autoClosed', true);
            $this->entityManager->saveEntity($shift);
        }
    }
}
