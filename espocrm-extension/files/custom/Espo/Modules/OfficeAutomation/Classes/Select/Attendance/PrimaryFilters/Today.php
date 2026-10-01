<?php

namespace Espo\Modules\OfficeAutomation\Classes\Select\Attendance\PrimaryFilters;

use DateTime;
use DateTimeZone;
use Espo\Core\Select\Primary\Filter;
use Espo\Core\Utils\Config;
use Espo\ORM\Query\SelectBuilder;

class Today implements Filter
{
    public function __construct(private Config $config) {}

    public function apply(SelectBuilder $queryBuilder): void
    {
        $tz = new DateTimeZone($this->config->get('timeZone') ?: 'UTC');
        $start = new DateTime('today', $tz);
        $end = (clone $start)->modify('+1 day');
        $utc = new DateTimeZone('UTC');

        $queryBuilder->where([
            'checkIn>=' => $start->setTimezone($utc)->format('Y-m-d H:i:s'),
            'checkIn<' => $end->setTimezone($utc)->format('Y-m-d H:i:s'),
        ]);
    }
}
