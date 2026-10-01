<?php

namespace Espo\Modules\OfficeAutomation\Classes\Select\Conversation\PrimaryFilters;

use Espo\Core\Select\Primary\Filter;
use Espo\ORM\Query\SelectBuilder;

class NeedsHuman implements Filter
{
    public function apply(SelectBuilder $queryBuilder): void
    {
        $queryBuilder->where(['status' => 'needs_human']);
    }
}
