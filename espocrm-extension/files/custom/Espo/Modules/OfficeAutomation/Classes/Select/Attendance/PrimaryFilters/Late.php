<?php

namespace Espo\Modules\OfficeAutomation\Classes\Select\Attendance\PrimaryFilters;

use Espo\Core\Select\Primary\Filter;
use Espo\ORM\Query\SelectBuilder;

class Late implements Filter
{
    public function apply(SelectBuilder $queryBuilder): void
    {
        $queryBuilder->where(['isLate' => true]);
    }
}
