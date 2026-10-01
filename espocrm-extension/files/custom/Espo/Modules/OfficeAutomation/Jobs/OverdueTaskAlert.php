<?php

namespace Espo\Modules\OfficeAutomation\Jobs;

use Espo\Core\Job\JobDataLess;
use Espo\Entities\Notification;
use Espo\Entities\User;
use Espo\ORM\EntityManager;

/**
 * Morning job: in-app notification to each assignee about their overdue tasks,
 * and one summary to every active admin (owner).
 */
class OverdueTaskAlert implements JobDataLess
{
    public function __construct(private EntityManager $entityManager) {}

    public function run(): void
    {
        $tasks = $this->entityManager->getRDBRepository('Task')
            ->where([
                'dateEnd<' => date('Y-m-d H:i:s'),
                'status!=' => ['Completed', 'Canceled', 'Deferred'],
                'assignedUserId!=' => null,
            ])
            ->find();

        $byUser = [];
        foreach ($tasks as $task) {
            $byUser[$task->get('assignedUserId')][] = $task->get('name');
        }
        if (!$byUser) {
            return;
        }

        foreach ($byUser as $userId => $names) {
            $this->notify($userId, sprintf('You have %d overdue task(s): %s', count($names), implode(', ', $names)));
        }

        $lines = [];
        foreach ($byUser as $userId => $names) {
            $user = $this->entityManager->getEntityById(User::ENTITY_TYPE, $userId);
            $lines[] = ($user ? $user->get('name') : $userId) . ': ' . count($names);
        }
        $summary = sprintf('%d overdue task(s) across staff — %s', array_sum(array_map('count', $byUser)), implode('; ', $lines));

        $admins = $this->entityManager->getRDBRepository(User::ENTITY_TYPE)
            ->where(['type' => 'admin', 'isActive' => true])->find();
        foreach ($admins as $admin) {
            $this->notify($admin->getId(), $summary);
        }
    }

    private function notify(string $userId, string $message): void
    {
        $this->entityManager->createEntity(Notification::ENTITY_TYPE, [
            'type' => Notification::TYPE_MESSAGE,
            'userId' => $userId,
            'message' => $message,
        ]);
    }
}
