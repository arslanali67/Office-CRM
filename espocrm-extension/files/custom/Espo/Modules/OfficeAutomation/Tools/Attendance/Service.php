<?php

namespace Espo\Modules\OfficeAutomation\Tools\Attendance;

use DateTime;
use DateTimeZone;
use Espo\Core\Exceptions\BadRequest;
use Espo\Core\Exceptions\Conflict;
use Espo\Core\Exceptions\Forbidden;
use Espo\Core\Utils\Config;
use Espo\Entities\User;
use Espo\ORM\Entity;
use Espo\ORM\EntityManager;
use stdClass;

class Service
{
    private const ENTITY = 'Attendance';

    public function __construct(
        private EntityManager $entityManager,
        private Config $config,
        private User $user
    ) {}

    /** @throws Forbidden @throws Conflict */
    public function checkIn(string $ip): Entity
    {
        $this->assertAllowedIp($ip);

        // Row lock on the user serialises double taps, so only one open shift can ever exist.
        return $this->entityManager->getTransactionManager()->run(function () use ($ip) {
            $this->lockUser();

            if ($this->findOpen()) {
                throw new Conflict('You are already checked in.');
            }

            $now = new DateTime('now', new DateTimeZone('UTC'));
            $local = (clone $now)->setTimezone($this->tz());
            [$h, $m] = array_map('intval', explode(':', $this->config->get('attendanceOfficeStart') ?: '09:00'));

            return $this->entityManager->createEntity(self::ENTITY, [
                'assignedUserId' => $this->user->getId(),
                'checkIn' => $now->format('Y-m-d H:i:s'),
                'ipAddress' => $ip,
                'isLate' => $local > (clone $local)->setTime($h, $m, 0),
            ]);
        });
    }

    /** @throws Forbidden @throws Conflict */
    public function checkOut(string $ip): Entity
    {
        $this->assertAllowedIp($ip);

        return $this->entityManager->getTransactionManager()->run(function () {
            $this->lockUser();

            $open = $this->findOpen() ?? throw new Conflict('You are not checked in.');
            $open->set('checkOut', gmdate('Y-m-d H:i:s'));
            $this->entityManager->saveEntity($open);

            return $open;
        });
    }

    public function status(): stdClass
    {
        $open = $this->findOpen();

        return (object) [
            'open' => (bool) $open,
            'checkIn' => $open?->get('checkIn'),
            'isLate' => $open ? (bool) $open->get('isLate') : false,
        ];
    }

    /**
     * Per-employee totals for a month (YYYY-MM, office time zone). Admin only.
     *
     * @throws Forbidden @throws BadRequest
     */
    public function monthlySummary(string $month): stdClass
    {
        if (!$this->user->isAdmin()) {
            throw new Forbidden();
        }
        if (!preg_match('/^\d{4}-(0[1-9]|1[0-2])$/', $month)) {
            throw new BadRequest('Month must be YYYY-MM.');
        }

        $utc = new DateTimeZone('UTC');
        $from = new DateTime("$month-01 00:00:00", $this->tz());
        $to = (clone $from)->modify('+1 month');

        $shifts = $this->entityManager->getRDBRepository(self::ENTITY)->where([
            'checkIn>=' => (clone $from)->setTimezone($utc)->format('Y-m-d H:i:s'),
            'checkIn<' => (clone $to)->setTimezone($utc)->format('Y-m-d H:i:s'),
        ])->find();

        $rows = [];
        foreach ($shifts as $s) {
            $id = $s->get('assignedUserId');
            $rows[$id] ??= ['userId' => $id, 'name' => $s->get('assignedUserName'), 'hours' => 0.0, 'days' => [], 'late' => 0, 'autoClosed' => 0, 'open' => 0];
            $rows[$id]['hours'] += (float) $s->get('hours');
            $rows[$id]['days'][(new DateTime($s->get('checkIn'), $utc))->setTimezone($this->tz())->format('Y-m-d')] = true;
            $rows[$id]['late'] += $s->get('isLate') ? 1 : 0;
            $rows[$id]['autoClosed'] += $s->get('autoClosed') ? 1 : 0;
            $rows[$id]['open'] += $s->get('checkOut') ? 0 : 1;
        }

        $list = array_map(
            fn ($r) => (object) array_merge($r, ['hours' => round($r['hours'], 2), 'days' => count($r['days'])]),
            array_values($rows)
        );
        usort($list, fn ($a, $b) => strcmp((string) $a->name, (string) $b->name));

        return (object) ['month' => $month, 'list' => $list];
    }

    private function lockUser(): void
    {
        $this->entityManager->getRDBRepository(User::ENTITY_TYPE)
            ->where(['id' => $this->user->getId()])->forUpdate()->findOne();
    }

    private function findOpen(): ?Entity
    {
        return $this->entityManager->getRDBRepository(self::ENTITY)
            ->where(['assignedUserId' => $this->user->getId(), 'checkOut' => null])
            ->order('checkIn', 'DESC')->findOne();
    }

    /** @throws Forbidden */
    private function assertAllowedIp(string $ip): void
    {
        // ponytail: exact IP match, no CIDR ranges; add if the office gets a block of addresses.
        $allowed = array_filter(array_map('trim', explode(',', (string) $this->config->get('attendanceAllowedIps'))));

        if ($allowed && !in_array($ip, $allowed, true)) {
            throw new Forbidden('Check in/out is only allowed from the office network.');
        }
    }

    private function tz(): DateTimeZone
    {
        return new DateTimeZone($this->config->get('timeZone') ?: 'UTC');
    }
}
