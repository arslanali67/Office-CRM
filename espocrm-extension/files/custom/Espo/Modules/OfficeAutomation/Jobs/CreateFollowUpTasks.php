<?php

namespace Espo\Modules\OfficeAutomation\Jobs;

use Espo\Core\Job\JobDataLess;
use Espo\ORM\EntityManager;

/**
 * Sent emails with "follow up if no reply by" in the past and no reply received
 * become a Task for the sender; the follow-up date is then cleared.
 */
class CreateFollowUpTasks implements JobDataLess
{
    public function __construct(private EntityManager $entityManager) {}

    public function run(): void
    {
        $emails = $this->entityManager->getRDBRepository('Email')->where([
            'status' => 'Sent',
            'followUpAt!=' => null,
            'followUpAt<' => gmdate('Y-m-d H:i:s'),
        ])->find();

        foreach ($emails as $email) {
            if (!$email->get('isReplied')) {
                $this->entityManager->createEntity('Task', [
                    'name' => 'Follow up: ' . $email->get('name'),
                    'assignedUserId' => $email->get('createdById'),
                    'parentType' => 'Email',
                    'parentId' => $email->getId(),
                    'dateEnd' => gmdate('Y-m-d H:i:s'),
                    'priority' => 'High',
                ]);
            }

            $email->set('followUpAt', null);
            $this->entityManager->saveEntity($email);
        }
    }
}
